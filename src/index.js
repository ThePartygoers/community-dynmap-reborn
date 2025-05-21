function lerp(a, b, alpha) {
    return a + (b - a) * alpha
}

class WorldMap {

    static VERSION = "v0.1.0"

    constructor(config) {
        this.config = config
        this.clock = 0
        this.app = new PIXI.Application({
            antialias: false,
            backgroundColor: 0x000000,
        })

        this.map_root = new PIXI.Container({ isRenderGroup: true })
        this.sprite_pool = []
        this.children_cache = {}

        this._derived_zoom = 1
        this._derived_lod = 2
        this._derived_depth = Math.floor(config.depth / 2)

        this.claims = {}
        this.claim_bounds = {}
        this.claim_quadtree = new Quadtree({
            x: 0,
            y: 0,
            width: this.config.tile_size * this.config.depth,
            height: this.config.tile_size * this.config.depth,
            max_objects: 8,
            max_depth: 12
        })
        
        this.pointer = {
            onscreen: true,
            m1: false,
            x: 0,
            y: 0,
            hasMoved: true
        }

        this.state = {
            x: 0,
            z: 0,
            zoom: -20
        }

        this.textures = {}

        this._last_candidates = new Set()

        this.stats = {
            tiles_rendered: 0,
            claims_rendered: 0,
            frametime: 0,
            quadtree_content: 0
        }

        this.hovered_claim = undefined

        this.debug = true
    }

    async load_map(id) {
        this.children_cache = {}
        this.textures = {}

        const root_path = `static/maps/${id}`
        const depth = Math.floor(this.config.depth / 2)

        for (let lod = this.config.lod - 1; lod > -1; lod--) {
            let promises = []
            let relative_depth = depth / Math.pow(2, lod)

            for (let x = -relative_depth; x <= relative_depth; x++) {
                for (let z = -relative_depth; z <= relative_depth; z++) {
                    promises.push(PIXI.Assets.load(`${root_path}/${lod}/${z}/${x}.png`).then(texture => {
                        this.textures[`${lod}/${x}/${z}`] = texture
                    }).catch(() => {}))
                }
            }
            await Promise.all(promises)
        }
    }

    async load_markers() {
        const response = await fetch("static/markers.json")
        this.claims = await response.json()

        const lowResGraphics = new PIXI.Graphics()
        lowResGraphics.name = "Temp"

        const scaleFactor = this.config.claims_low_res / (this.config.depth * this.config.tile_size)

        for (const [id, claim] of Object.entries(this.claims)) {
            let points = []

            claim.shape.forEach(point => {
                points.push(point.x * scaleFactor + this.config.claims_low_res / 2)
                points.push(point.z * scaleFactor + this.config.claims_low_res / 2)
            })
            
            lowResGraphics.beginFill(this.rgbToInt(
                    claim.fillColor.r,
                    claim.fillColor.g,
                    claim.fillColor.b
            ), 0.5)
            lowResGraphics.drawPolygon(points)
            lowResGraphics.endFill()
        }

        
        const texture = PIXI.RenderTexture.create({ width: this.config.claims_low_res, height: this.config.claims_low_res })
        this.app.renderer.render(lowResGraphics, { renderTexture: texture })

        this.claim_low_res.texture = texture
    }

    async init() {
        await this.app.init()

        this.textures["sample"] = await PIXI.Assets.load("sample.png")
        await PIXI.Assets.load("assets/round_6x6.xml")

        document.body.appendChild(this.app.canvas)
        this.app.canvas.addEventListener("contextmenu", e => e.preventDefault())

        this.load_map("bluemap")
        this.load_markers()
        this.registerEvents()

        const debug_container = new PIXI.Container()
        debug_container.name = "Debug"
        debug_container.visible = false
        debug_container.zIndex = 10

        this.grid_graphics = new PIXI.Graphics()
        this.grid_graphics.name = "Grid"
        this.grid_graphics.alpha = .5
        this.grid_graphics.zIndex = 2
        this.grid_graphics.blendMode = "multiply"

        this.claim_low_res = new PIXI.Sprite()
        this.claim_low_res.name = "Claims LR"
        this.claim_low_res.zIndex = 1
        this.claim_low_res.anchor.x = 0.5
        this.claim_low_res.anchor.y = 0.5
        
        this.claims_high_res = new PIXI.Graphics()
        this.claims_high_res.name = "Claims HR"
        this.claims_high_res.zIndex = 1

        let frametime_avg = 0
        let debug_lines = [
            () => `[DEBUG] Community Dynmap Reborn ${WorldMap.VERSION}`,
            () => {
                frametime_avg = lerp(frametime_avg, this.stats.frametime, 0.1)
                return `FPS: ${this.app.ticker.FPS.toFixed(1)} (VSYNC) ${(frametime_avg/(1000/144)*100).toFixed(2)}% ${frametime_avg.toFixed(4)}ms`
            },
            () => `T: ${this.stats.tiles_rendered} P: ${this.sprite_pool.length}`,
            () => `POS: ${Math.round(this.state.x)} ${Math.round(this.state.z)} ZOOM: ${this.state.zoom.toFixed(1)}`,
            () => `LOD: ${this._derived_lod} SF: ${Math.floor(this._derived_zoom * 100) / 100}`,
            () => `CHILDREN: ${Object.keys(this.children_cache).length}`,
            () => `LOADED: ${Object.keys(this.textures).length}/844`,
            () => `GRID: S ${this.getGridSpacing()}`,
            () => `CLAIMS: [${this.stats.claims_rendered > 0 ? "HIGH" : "LOW" }] ${this.stats.claims_rendered}/${Object.keys(this.claims).length}`,
            () => `POINTER: ${this.pointer.onscreen} ${this.pointer.x} ${this.pointer.y} ${this.pointer.m1}`,
            () => `CANDIDATES: ${this.stats.candidates}/${this.stats.quadtree_content}`
        ]

        if (this.debug) {
            let yHeight = 10
            debug_lines = debug_lines.map(line => {
                const debug_text = new PIXI.BitmapText({
                    text: line(),
                    style: {
                        fontFamily: 'round_6x6',
                        fontSize: 20,
                        align: 'left',
                    }
                })

                debug_text.y = yHeight
                debug_container.addChild(debug_text)

                yHeight += 22

                return () => {
                    debug_text.text = line()
                }
            })
            debug_container.visible = true
        }
        
        this.app.stage.addChild(this.map_root)
        this.app.stage.addChild(this.claim_low_res)
        this.app.stage.addChild(this.claims_high_res)
        this.app.stage.addChild(this.grid_graphics)
        this.app.stage.addChild(debug_container)
        
        this.app.ticker.add((ticker) => {
            this.tick()

            if (debug_container.visible) {
                debug_container.y = document.body.clientHeight - 22 * debug_lines.length
                debug_lines.forEach(line => line())
            }

            this.clock += ticker.deltaTime
        })
    }

    tick() {
        const perf_begin = performance.now()

        this._derived_zoom = Math.pow(1.1, this.state.zoom)

        const screenWidth = document.body.clientWidth
        const screenHeight = document.body.clientHeight

        this.app.renderer.resize(screenWidth, screenHeight)

        this._derived_lod = Math.max(Math.min(this.config.lod - 1, Math.floor(Math.log2(1 / this._derived_zoom))), 0)

        let tiles = 0

        for (let lod = this.config.lod - 1; lod >= this._derived_lod; lod--) {
            const tileOrigin = this.toWorldSpace([0, 0])

            const sizeOfTileBlocks = this.config.tile_size * Math.pow(2, lod)
            const sizeOfTilePx = this._derived_zoom * sizeOfTileBlocks
            
            tileOrigin[0] = Math.floor(tileOrigin[0] / sizeOfTileBlocks)
            tileOrigin[1] = Math.floor(tileOrigin[1] / sizeOfTileBlocks)

            const tilesAcrossWidth = Math.ceil(screenWidth / sizeOfTilePx) + 2
            const tilesAcrossHeight = Math.ceil(screenHeight / sizeOfTilePx) + 2

            for (let local_tile_x = 0; local_tile_x < tilesAcrossWidth; local_tile_x++) {
                for (let local_tile_z = 0; local_tile_z < tilesAcrossHeight; local_tile_z++) {

                    const global_tile_x = tileOrigin[0] + local_tile_x
                    const global_tile_z = tileOrigin[1] + local_tile_z

                    if (Math.abs(global_tile_x) > this._derived_depth / Math.pow(2, lod)) continue
                    if (Math.abs(global_tile_z) > this._derived_depth / Math.pow(2, lod)) continue

                    tiles++
                }
            }
        }

        this.stats.tiles_rendered = tiles

        const sprites = this.allocateSprites(tiles)

        for (let lod = this.config.lod - 1; lod >= this._derived_lod; lod--) {
            const tileOrigin = this.toWorldSpace([0, 0])

            const sizeOfTileBlocks = this.config.tile_size * Math.pow(2, lod)
            const sizeOfTilePx = this._derived_zoom * sizeOfTileBlocks
            
            tileOrigin[0] = Math.floor(tileOrigin[0] / sizeOfTileBlocks)
            tileOrigin[1] = Math.floor(tileOrigin[1] / sizeOfTileBlocks)

            const tilesAcrossWidth = Math.ceil(screenWidth / sizeOfTilePx) + 2
            const tilesAcrossHeight = Math.ceil(screenHeight / sizeOfTilePx) + 2

            for (let local_tile_x = 0; local_tile_x < tilesAcrossWidth; local_tile_x++) {
                for (let local_tile_z = 0; local_tile_z < tilesAcrossHeight; local_tile_z++) {

                    const global_tile_x = tileOrigin[0] + local_tile_x
                    const global_tile_z = tileOrigin[1] + local_tile_z

                    if (Math.abs(global_tile_x) > this._derived_depth / Math.pow(2, lod)) continue
                    if (Math.abs(global_tile_z) > this._derived_depth / Math.pow(2, lod)) continue

                    const sprite = sprites.pop()

                    if (sprite == undefined) break

                    const screenSpace = this.toScreenSpace([
                        global_tile_x * sizeOfTileBlocks,
                        global_tile_z * sizeOfTileBlocks
                    ])

                    const tile_id = `${lod}/${global_tile_x}/${global_tile_z}`

                    sprite.name = tile_id

                    let children_drawn = this.children_cache[tile_id] || false

                    if (lod > 0 && this._derived_lod < lod) {
                        const child_origin = this.toWorldSpace([0, 0])
                        child_origin[0] = Math.floor(child_origin[0] / sizeOfTileBlocks / 2)
                        child_origin[1] = Math.floor(child_origin[1] / sizeOfTileBlocks / 2)

                        const child0 = `${lod - 1}/${child_origin[0]}/${child_origin[1]}`
                        const child1 = `${lod - 1}/${child_origin[0] + 1}/${child_origin[1]}`
                        const child2 = `${lod - 1}/${child_origin[0]}/${child_origin[1] + 1}`
                        const child3 = `${lod - 1}/${child_origin[0] + 1}/${child_origin[1] + 1}`

                        if (
                            this.textures[child0] != undefined &&
                            this.textures[child1] != undefined &&
                            this.textures[child2] != undefined &&
                            this.textures[child3] != undefined
                        ) {
                            children_drawn = true
                            this.children_cache[tile_id] = true
                        }
                    }

                    if (tile_id in this.textures && (!children_drawn || this._derived_lod >= lod)) {
                        sprite.texture = this.textures[tile_id]
                        sprite.x = screenSpace[0]
                        sprite.y = screenSpace[1]
                        sprite.width = sizeOfTilePx
                        sprite.height = sizeOfTilePx
                        sprite.visible = true
                    } else {
                        sprite.visible = false
                    }
                }
            }
        }

        const grid_spacing = this.getGridSpacing()

        this.grid_graphics.clear()
        if (grid_spacing) {
            let grid_world_origin = this.toWorldSpace([0, 0])

            grid_world_origin[0] = Math.floor(grid_world_origin[0] / grid_spacing) * grid_spacing
            grid_world_origin[1] = Math.floor(grid_world_origin[1] / grid_spacing) * grid_spacing

            const grid_screen_origin = this.toScreenSpace(grid_world_origin)

            const grid_pixel_size = grid_spacing * this._derived_zoom
            const linesAcrossWidth = screenWidth / grid_pixel_size + 1
            const linesAcrossHeight = screenWidth / grid_pixel_size + 1

            for (let column = 0; column < linesAcrossWidth; column++) {
                this.grid_graphics.moveTo(grid_screen_origin[0] + column * grid_pixel_size, 0).lineTo(grid_screen_origin[0] + column * grid_pixel_size, screenHeight)
                
            }
            this.grid_graphics.stroke({ color: 0x777777, pixelLine: true })

            for (let row = 0; row < linesAcrossHeight; row++) {
                this.grid_graphics.moveTo(0, grid_screen_origin[1] + row * grid_pixel_size).lineTo(screenWidth, grid_screen_origin[1] + row * grid_pixel_size)
                
            }
            this.grid_graphics.stroke({ color: 0x555555, pixelLine: true })
        }

        let cursor_world_pos = this.toWorldSpace([this.pointer.x, this.pointer.y])

        let pointer_candidates = this._last_candidates

        if (this.pointer.hasMoved && this.pointer.onscreen) {
            pointer_candidates = new Set(this.claim_quadtree.retrieve({
                x: cursor_world_pos[0],
                y: cursor_world_pos[1],
                width: 1,
                height: 1,
            }).map(x => x.id))

            this._last_candidates = pointer_candidates
        }

        this.stats.candidates = pointer_candidates.size

        let claims_rendered = 0

        if (this._derived_lod > 0) {
            let low_res_origin = this.toScreenSpace([0, 0])
            this.claim_low_res.x = low_res_origin[0]
            this.claim_low_res.y = low_res_origin[1]
            this.claim_low_res.scale = this._derived_zoom / (this.config.claims_low_res / this.config.tile_size / this.config.depth)
            this.claim_low_res.visible = true
            this.claims_high_res.visible = false
        } else {
            this.claim_low_res.visible = false
            
            this.claims_high_res.clear()
    
            for (const [id, claim] of Object.entries(this.claims)) {

                let bounding_box = this.getClaimBounds(id)
                
                if (bounding_box == undefined) continue

                bounding_box = bounding_box.map(point => {
                    return this.toScreenSpace(point)
                })

                if (bounding_box[1][0] < 0) continue
                if (bounding_box[1][1] < 0) continue
                if (bounding_box[0][0] > screenWidth) continue
                if (bounding_box[0][1] > screenHeight) continue

                if (!this.rectanglesIntersect(bounding_box, [[0, 0], [screenWidth, screenHeight]])) {
                    continue
                }

                let isHovered = false

                let points = []

                claim.shape.forEach(point => {
                    const screen_pos = this.toScreenSpace([point.x, point.z])

                    points.push(screen_pos[0])
                    points.push(screen_pos[1])
                })

                if (this.pointer.onscreen) {
                    if (this.pointer.hasMoved == false) {
                        if (this.hovered_claim == id) {
                            isHovered = true
                        }
                    } else if (pointer_candidates.has(id)) {
                        if (
                            this.pointer.x > bounding_box[0][0] &&
                            this.pointer.x < bounding_box[1][0] &&
                            this.pointer.y > bounding_box[0][1] &&
                            this.pointer.y < bounding_box[1][1]
                        ) {
                            const polygon = new PIXI.Polygon(points)

                            if (polygon.contains(this.pointer.x, this.pointer.y)) {
                                isHovered = true
                                this.hovered_claim = id
                            }
                        }
                    }
                }

                

                const path = new PIXI.GraphicsPath().moveTo(points[0], points[1])

                let clr = this.rgbToInt(
                    claim.fillColor.r,
                    claim.fillColor.g,
                    claim.fillColor.b
                )

                if (isHovered) {
                    clr = 0xFFFFFF
                }

                for (let i = 2; i < points.length; i+=2) {
                    path.lineTo(points[i], points[i + 1])
                }

                path.closePath()

                this.claims_high_res.path(path)

                if (this.state.zoom >= 10) {
                    this.claims_high_res.stroke({
                        color: clr,
                        alpha: 0.5,
                        width: 5
                    }, path)
                } else {
                    this.claims_high_res.fill({
                        color: clr,
                        alpha: 0.5
                    }, path)
                }

                claims_rendered++
            }

            this.claims_high_res.visible = true
        }

        this.stats.claims_rendered = claims_rendered

        this.stats.frametime = performance.now() - perf_begin
    }

    rgbToInt(r, g, b) {
        return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
    }

    getGridSpacing() {
        if (this.state.zoom >= 30) {
            return 1
        } else if (this.state.zoom >= 10) {
            return 16
        }
    }

    registerEvents() {
        let mouseStartX = 0
        let mouseStartY = 0
        let dragging = false

        let mapStartX = 0
        let mapStartY = 0

        window.addEventListener("pointermove", event => {
            this.pointer.x = event.clientX
            this.pointer.y = event.clientY
            this.pointer.hasMoved = true
        })

        document.addEventListener("mouseenter", event => {
            this.pointer.onscreen = true
        })


        document.addEventListener("mouseleave", event => {
            this.pointer.onscreen = false
        })

        window.addEventListener("mousedown", event => {
            mouseStartX = event.x
            mouseStartY = event.y
            dragging = true

            mapStartX = this.state.x
            mapStartY = this.state.z
        })

        window.addEventListener("mousemove", event => {
            if (dragging) {
                const delta_x = (mouseStartX - event.x) / this._derived_zoom
                const delta_y = (mouseStartY - event.y) / this._derived_zoom

                this.state.x = mapStartX + delta_x
                this.state.z = mapStartY + delta_y
            }
        })

        window.addEventListener("mouseup", event => {
            dragging = false
        })

        window.addEventListener("wheel", event => {
            this.state.zoom = Math.max(this.config.min_zoom, Math.min(this.config.max_zoom, this.state.zoom - event.deltaY / 100))
        })

        let zooming = false
        let initial_zoom = 0
        let initial_touch_delta = 0
        window.addEventListener("touchstart", event => {
            this.pointer.onscreen = true

            if (event.touches.length == 2) {
                zooming = true
                initial_zoom = this.state.zoom

                const dx = event.touches[0].screenX - event.touches[1].screenX
                const dy = event.touches[0].screenY - event.touches[1].screenY

                initial_touch_delta = Math.sqrt(
                    dx * dx + dy * dy
                )
            }

            mouseStartX = event.touches[0].screenX
            mouseStartY = event.touches[0].screenY
            dragging = true

            mapStartX = this.state.x
            mapStartY = this.state.z
        })

        window.addEventListener("touchmove", event => {
            if (zooming && event.touches.length == 2) {
                const dx = event.touches[0].screenX - event.touches[1].screenX
                const dy = event.touches[0].screenY - event.touches[1].screenY

                const touch_delta = Math.sqrt(
                    dx * dx + dy * dy
                )

                const delta = initial_touch_delta - touch_delta

                this.state.zoom = Math.max(this.config.min_zoom, Math.min(this.config.max_zoom, initial_zoom - delta * 0.1))
            }

            if (dragging) {
                const delta_x = (mouseStartX - event.touches[0].screenX) / this._derived_zoom
                const delta_y = (mouseStartY - event.touches[0].screenY) / this._derived_zoom

                this.state.x = mapStartX + delta_x
                this.state.z = mapStartY + delta_y
            }
		})

        window.addEventListener("touchend", event => {
            this.pointer.onscreen = false

            zooming = false
            dragging = false
		})
    }

    rectanglesIntersect([[x1, y1], [x2, y2]], [[x3, y3], [x4, y4]]) {
        const [left1, right1] = [Math.min(x1, x2), Math.max(x1, x2)]
        const [top1, bottom1] = [Math.min(y1, y2), Math.max(y1, y2)]
        const [left2, right2] = [Math.min(x3, x4), Math.max(x3, x4)]
        const [top2, bottom2] = [Math.min(y3, y4), Math.max(y3, y4)]

        return !(right1 < left2 || right2 < left1 || bottom1 < top2 || bottom2 < top1)
    }

    getClaimBounds(id) {
        let bounds = this.claim_bounds[id]
        if (bounds) {
            return bounds
        }

        let min_x = 9e9
        let min_z = 9e9
        let max_x = 0
        let max_z = 0

        const claim = this.claims[id]

        if (claim) {
            claim.shape.forEach(point => {
                min_x = Math.min(point.x, min_x)
                max_x = Math.max(point.x, max_x)
                min_z = Math.min(point.z, min_z)
                max_z = Math.max(point.z, max_z)
            })

            bounds = [[min_x, min_z], [max_x, max_z]]

            this.stats.quadtree_content += 1
            this.claim_quadtree.insert({
                x: (min_x + max_x) / 2,
                y: (min_z + max_z) / 2,
                width: (max_x - min_x),
                height: (max_z - min_z),
                id: id
            })

            this.claim_bounds[id] = bounds

            return bounds
        }
    }

    allocateSprites(count) {
        let sprites = []
        let head = 0

        while (sprites.length < count) {
            if (head >= this.sprite_pool.length) {
                const sprite = PIXI.Sprite.from("sample.png")

                this.map_root.addChild(sprite)
                this.app.stage.addChild(sprite)

                this.sprite_pool.push(sprite)
            }

            sprites.push(this.sprite_pool[head])
            head++

            if (head > this.config.max_sprites) break
        }

        for (let i = head; i < this.sprite_pool.length; i++) {
            const sprite = this.sprite_pool[i]

            sprite.visible = false
        }

        return sprites
    }

    toScreenSpace([wx, wz]) {
        const halfWidth = this.app.renderer.screen.width / 2
        const halfHeight = this.app.renderer.screen.height / 2

        return [
            (wx - this.state.x) * this._derived_zoom + halfWidth,
            (wz - this.state.z ) * this._derived_zoom + halfHeight
        ]
    }

    toWorldSpace([sx, sy]) {
        const halfWidth = this.app.renderer.screen.width / 2
        const halfHeight = this.app.renderer.screen.height / 2
        return [
            (sx - halfWidth) / this._derived_zoom + this.state.x,
            (sy - halfHeight) / this._derived_zoom + this.state.z
        ]
    }
}

// Put this shit in the documentation, jesus fucking christ
// Like how the actual fuck am I supposed to figure this shit out without reading the source code
PIXI.TextureSource.defaultOptions.scaleMode = 'nearest'
PIXI.AbstractRenderer.defaultOptions.roundPixels = true

window.WorldMap = WorldMap

WorldMap.instance = new WorldMap({
    tile_size: 1024,
    depth: 25,
    lod: 3,
    max_sprites: 200,
    claims_low_res: 4096,
    min_zoom: -50,
    max_zoom: 50
})
await WorldMap.instance.init()
globalThis.__PIXI_APP__ = WorldMap.instance.app

