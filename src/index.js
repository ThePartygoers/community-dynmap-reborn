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

        this.state = {
            x: 0,
            z: 0,
            zoom: -20
        }

        this.textures = {}

        this.stats = {
            tiles_rendered: 0
        }

        this.debug = true
    }

    async load_map(id) {
        this.children_cache = {}
        this.textures = {}

        const root_path = `static/${id}`
        const depth = this.config.depth

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

    async init() {
        await this.app.init()

        this.textures["sample"] = await PIXI.Assets.load("sample.png")
        await PIXI.Assets.load("assets/round_6x6.xml")

        document.body.appendChild(this.app.canvas)
        this.app.canvas.addEventListener("contextmenu", e => e.preventDefault())

        this.load_map("bluemap")
        this.registerEvents()

        const debug_container = new PIXI.Container()
        debug_container.visible = false
        debug_container.zIndex = 10

        this.grid = new PIXI.Graphics()
        this.grid.alpha = 1
        this.grid.zIndex = 1

        let debug_lines = [
            () => `[DEBUG] Community Dynmap Reborn ${WorldMap.VERSION}`,
            () => `FPS: ${this.app.ticker.FPS.toFixed(1)} (VSYNC)`,
            () => `T: ${this.stats.tiles_rendered} P: ${this.sprite_pool.length}`,
            () => `POS: ${Math.round(this.state.x)} ${Math.round(this.state.z)} ZOOM: ${this.state.zoom.toFixed(1)}`,
            () => `LOD: ${this._derived_lod} SF: ${Math.floor(this._derived_zoom * 100) / 100}`,
            () => `CHILDREN: ${Object.keys(this.children_cache).length}`,
            () => `LOADED: ${Object.keys(this.textures).length}/844`,
            () => `GRID: S ${this.getGridSpacing()}`
        ]

        if (this.debug) {
            let yHeight = 10;
            debug_lines = debug_lines.map(line => {
                const debug_text = new PIXI.BitmapText({
                    text: line(),
                    style: {
                        fontFamily: 'round_6x6',
                        fontSize: 20,
                        align: 'left',
                    }
                });

                debug_text.y = yHeight;
                debug_container.addChild(debug_text)

                yHeight += 22;

                return () => {
                    debug_text.text = line()
                }
            })
            debug_container.visible = true
        }
        
        this.app.stage.addChild(this.map_root)
        this.app.stage.addChild(this.grid)
        this.app.stage.addChild(debug_container)
        
        this.app.ticker.add((ticker) => {
            this.tick()

            if (debug_container.visible) {
                debug_lines.forEach(line => line())
            }

            this.clock += ticker.deltaTime;
        })
    }

    tick() {
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

                    if (Math.abs(global_tile_x) > this.config.depth / Math.pow(2, lod)) continue
                    if (Math.abs(global_tile_z) > this.config.depth / Math.pow(2, lod)) continue

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

                    if (Math.abs(global_tile_x) > this.config.depth / Math.pow(2, lod)) continue
                    if (Math.abs(global_tile_z) > this.config.depth / Math.pow(2, lod)) continue

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

        this.grid.clear()
        if (grid_spacing) {
            let grid_world_origin = this.toWorldSpace([0, 0])

            grid_world_origin[0] = Math.floor(grid_world_origin[0] / grid_spacing) * grid_spacing
            grid_world_origin[1] = Math.floor(grid_world_origin[1] / grid_spacing) * grid_spacing

            const grid_screen_origin = this.toScreenSpace(grid_world_origin)

            const grid_pixel_size = grid_spacing * this._derived_zoom
            const linesAcrossWidth = screenWidth / grid_pixel_size + 1
            const linesAcrossHeight = screenWidth / grid_pixel_size + 1

            for (let column = 0; column < linesAcrossWidth; column++) {
                this.grid.moveTo(grid_screen_origin[0] + column * grid_pixel_size, 0).lineTo(grid_screen_origin[0] + column * grid_pixel_size, screenHeight)
                
            }
            this.grid.stroke({ color: 0xffffff, pixelLine: true });

            for (let row = 0; row < linesAcrossHeight; row++) {
                this.grid.moveTo(0, grid_screen_origin[1] + row * grid_pixel_size).lineTo(screenWidth, grid_screen_origin[1] + row * grid_pixel_size)
                
            }
            this.grid.stroke({ color: 0xffffff, pixelLine: true });
        }
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
            this.state.zoom += -event.deltaY / 100
        })

        let zooming = false
        let initial_zoom = 0
        let initial_touch_delta = 0
        window.addEventListener("touchstart", event => {
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

                this.state.zoom = initial_zoom - delta * 0.1
            }

            if (dragging) {
                const delta_x = (mouseStartX - event.touches[0].screenX) / this._derived_zoom
                const delta_y = (mouseStartY - event.touches[0].screenY) / this._derived_zoom

                this.state.x = mapStartX + delta_x
                this.state.z = mapStartY + delta_y
            }
		})

        window.addEventListener("touchend", event => {
            zooming = false
            dragging = false
		})
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
            head++;

            if (head > this.config.max_sprites) break
        }

        for (let i = head; i < this.sprite_pool.length; i++) {
            const sprite = this.sprite_pool[i]

            sprite.visible = false
        }

        return sprites
    }

    toScreenSpace([wx, wz]) {
        const halfWidth = this.app.renderer.screen.width / 2;
        const halfHeight = this.app.renderer.screen.height / 2;

        return [
            (wx - this.state.x) * this._derived_zoom + halfWidth,
            (wz - this.state.z ) * this._derived_zoom + halfHeight
        ];
    }

    toWorldSpace([sx, sy]) {
        const halfWidth = this.app.renderer.screen.width / 2;
        const halfHeight = this.app.renderer.screen.height / 2;
        return [
            (sx - halfWidth) / this._derived_zoom + this.state.x,
            (sy - halfHeight) / this._derived_zoom + this.state.z
        ];
    }
}

// Put this shit in the documentation, jesus fucking christ
// Like how the actual fuck am I supposed to figure this shit out without reading the source code
PIXI.TextureSource.defaultOptions.scaleMode = 'nearest';
PIXI.AbstractRenderer.defaultOptions.roundPixels = true;

window.WorldMap = WorldMap

WorldMap.instance = new WorldMap({
    tile_size: 1024,
    depth: 12,
    lod: 3,
    max_sprites: 200
})
await WorldMap.instance.init()
globalThis.__PIXI_APP__ = WorldMap.instance.app

