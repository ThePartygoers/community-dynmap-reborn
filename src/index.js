import { Annotations, PolygonAnnotation, RectangleAnnotation } from "./annotate.js"
import { Handle } from "./handle.js"

const x_input = document.getElementById("ui_x")
const z_input = document.getElementById("ui_z")
const search_span = document.getElementById("search_span")
const search_results = document.getElementById("search_results")

const claim_panel = document.getElementById("claim_panel")
const claim_panel_name = document.getElementById("claim_name")
const claim_panel_owner = document.getElementById("claim_owner")
const claim_panel_balance = document.getElementById("claim_balance")
const claim_panel_flag = document.getElementById("claim_flag")
const claim_panel_owner_model = document.getElementById("claim_owner_model")
const claim_panel_players = document.getElementById("claim_players")

const claim_button_container = document.getElementById("claim_button_container")
const claim_teleport = document.getElementById("claim_teleport")
const claim_deselect = document.getElementById("claim_deselect")
const claim_share = document.getElementById("claim_share")

const map_selector = document.getElementById("map_selector")

const context_menu = document.getElementById("context_menu")
const context_copy = document.getElementById("context_copy")
const context_copy_link = document.getElementById("context_copy_link")

function lerp(a, b, alpha) {
    return a + (b - a) * alpha
}

function manhattanDistance([x1, y1], [x2, y2]) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2)
}

class WorldMap {

    static VERSION = "v1.0.0"

    constructor(config) {
        this.config = config
        this.clock = 0
        this.app = new PIXI.Application({
            antialias: false,
            backgroundColor: 0x000000,
        })

        this.map_root = new PIXI.Container({ isRenderGroup: true })
        this.map_root.name = "MapRoot"

        this.claim_high_res_group = new PIXI.Container({ isRenderGroup: true })
        this.claim_high_res_group.name = "Claim HR"

        this.annotation_layer = new PIXI.Container({ isRenderGroup: true })
        this.annotation_layer.name = "Annotation"

        this.map_tile_sprite_pool = []
        this.children_cache = {}

        this._derived_zoom = 1
        this._derived_lod = 2
        this._derived_depth = Math.floor(config.depth / 2)

        this.last_search = []
        this.search_index = 0

        this.lazy_update = false

        this.claims = {}
        this.claim_name_lookup = {}
        this.claim_bounds = {}
        this.claim_path = {}
        this.claim_graphics = {}
        this.force_claim_redraw = false
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
            zoom: -20,
            selected_block : undefined,
            map: undefined
        }

        this.lazy_update_rect_selection = true
        this.rect_selection = undefined

        this.data_promise = undefined

        this.loading_tickets = {}
        this.textures = {}
        
        this.annotations = []

        this.handles = []

        this._last_candidates = new Set()

        this.stats = {
            tiles_rendered: 0,
            claims_rendered: 0,
            frametime: 0,
            quadtree_content: 0,
            updateTimestamp: 0
        }

        this.hovered_claim = undefined
        this.focused_claim = undefined

        this.debug = true

        this.setFocusedClaim(undefined)
    }

    async update_map_ui(id) {
        let children = []
        this.meta.maps.forEach(map => {
            const parent_div = document.createElement("div")

            const span = document.createElement("span")
            span.innerText = map.name
            parent_div.appendChild(span)

            const p = document.createElement("p")
            p.innerText = map.desc
            parent_div.appendChild(p)

            parent_div.classList.add("map_option")
            if (id == map.id) {
                parent_div.classList.add("map_option_selected")
            }

            parent_div.addEventListener("click", event => {
                this.update_map_ui(map.id)
                this.load_map(map.id)
            })

            children.push(parent_div)
        })

        map_selector.replaceChildren(...children)
    }

    async load_map(id) {
        this.state.map = id
        this.children_cache = {}
        this.textures = {}
        this.lazy_update = false

        this.map_tile_sprite_pool.forEach(sprite => {
            sprite.visible = false
        })

        const depth = Math.floor(this.config.depth / 2)

        // load first lod
        for (let lod = this.config.lod - 1; lod >= this.config.lod - 1; lod--) {
            let promises = []
            let relative_depth = depth / Math.pow(2, lod)

            for (let x = -relative_depth; x <= relative_depth; x++) {
                for (let z = -relative_depth; z <= relative_depth; z++) {
                    if (id == this.state.map) {
                        promises.push(this.load_tile(id, lod, x, z))
                    }
                }
            }
            await Promise.all(promises)
        }

        this.saveParams()
    }

    async load_tile(map, lod, x, z) {
        const root_path = `static/maps/${map}`

        this.loading_tickets[`${lod}/${z}/${x}`] = true

        return await PIXI.Assets.load(`${root_path}/${lod}/${z}/${x}.png`).then(texture => {
            if (map == this.state.map) {
                this.textures[`${lod}/${x}/${z}`] = texture
                this.textures.ttl = Date.now()
            }
            this.loading_tickets[`${lod}/${z}/${x}`] = undefined
        }).catch(() => {})
    }

    async pullData() {
        const meta_response = await fetch("static/meta.json")
        this.meta = await meta_response.json()

        const claims_response = await fetch("static/claims.json")
        const decoded_claims = await claims_response.json()
        this.claims = decoded_claims.claims
        this.stats.updateTimestamp = decoded_claims.timestamp * 1000

        const lowResGraphics = new PIXI.Graphics()

        const scaleFactor = this.config.claims_low_res / (this.config.depth * this.config.tile_size)

        for (const [id, claim] of Object.entries(this.claims)) {
            this.claim_name_lookup[claim.name] = id
            let low_res_space_points = []

            claim.shape.forEach(point => {
                low_res_space_points.push(point.x * scaleFactor + this.config.claims_low_res / 2)
                low_res_space_points.push(point.z * scaleFactor + this.config.claims_low_res / 2)
            })
            
            lowResGraphics.beginFill(this.rgbToInt(
                    claim.fillColor.r,
                    claim.fillColor.g,
                    claim.fillColor.b
            ), 0.5)
            lowResGraphics.drawPolygon(low_res_space_points)
            lowResGraphics.endFill()
        }

        
        const low_res_texture = PIXI.RenderTexture.create({ width: this.config.claims_low_res, height: this.config.claims_low_res })
        this.app.renderer.render(lowResGraphics, { renderTexture: low_res_texture })

        this.claim_low_res.texture = low_res_texture
    }

    async init() {

        if (window.matchMedia('(max-width: 480px)').matches)  {
            document.body.style.setProperty("--dyn-search-text", "'Search by claim, nation or player'")
        }

        await this.app.init()

        this.textures["sample"] = await PIXI.Assets.load("sample.png")
        await PIXI.Assets.load("assets/round_6x6.xml")

        document.body.appendChild(this.app.canvas)

        this.load_map(this.config.initial_map)
        this.data_promise = this.pullData().then(() => {
            this.update_map_ui("bluemap")
        })
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

        this.block_selection_graphics = new PIXI.Graphics()
        this.block_selection_graphics.name = "Block Selection"
        this.block_selection_graphics.zIndex = 3
        this.block_selection_graphics.blendMode = "multiply"

        this.rect_selection_graphics = new PIXI.Graphics()
        this.rect_selection_graphics.name = "Rect Selection"
        this.rect_selection_graphics.zIndex = 3
        this.rect_selection_graphics.blendMode = "multiply"

        this.block_selection_graphics.moveTo(0, 0)
            .lineTo(this.config.block_selection_stroke, 0)
            .lineTo(this.config.block_selection_stroke, this.config.block_selection_stroke)
            .lineTo(0, this.config.block_selection_stroke)
            .closePath()
            .stroke({ color: 0x777777, width: 2 })

        this.block_hover = new PIXI.Graphics()
        this.block_hover.name = "Block Hover"
        this.block_hover.zIndex = 3
        this.block_hover.blendMode = "multiply"

        this.block_hover.moveTo(0, 0)
            .lineTo(this.config.block_selection_stroke, 0)
            .lineTo(this.config.block_selection_stroke, this.config.block_selection_stroke)
            .lineTo(0, this.config.block_selection_stroke)
            .closePath()
            .fill({ color: 0xBBBBBB })

        
        this.tooltip_containter = new PIXI.Container()
        this.tooltip_containter.name = "Tooltip"
        this.tooltip_containter.zIndex = 10

        this.tooltip_text = new PIXI.HTMLText({
            text: "<strong>0 0</strong>",
            style: {
                fill: "#FFFFFF",
                fontFamily: "Segoe UI, SF Pro Display, -apple-system, BlinkMacSystemFont, Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
                fontSize: "smaller"
            }
        })
        this.tooltip_text.x = 8
        this.tooltip_text.y = 4
        this.tooltip_text.zIndex = 10

        this.tooltip_text.style.addOverride('text-shadow: 2px 2px 4px rgba(0,0,0,0.5)');
        this.tooltip_containter.addChild(this.tooltip_text)

        this.active_annotation = this.createAnnotations()

        let frametime_avg = 0
        let debug_lines = [
            () => `[DEBUG] Community Dynmap Reborn ${WorldMap.VERSION}`,
            () => {
                frametime_avg = lerp(frametime_avg, this.stats.frametime, 0.1)
                return `FPS: ${this.app.ticker.FPS.toFixed(1)} (VSYNC) ${(frametime_avg/(1000/144)*100).toFixed(2)}% ${frametime_avg.toFixed(4)}ms ${this.lazy_update ? "LAZY" : "FULL"}`
            },
            () => `${this.state.map} T: ${this.stats.tiles_rendered} P: ${this.map_tile_sprite_pool.length} ${new Date(this.stats.updateTimestamp).toISOString()}`,
            () => `POS: ${Math.round(this.state.x)} ${Math.round(this.state.z)} ZOOM: ${this.state.zoom.toFixed(1)}`,
            () => `LOD: ${this._derived_lod} SF: ${Math.floor(this._derived_zoom * 100) / 100}`,
            () => `CHILDREN: ${Object.keys(this.children_cache).length}`,
            () => `LOADED: ${Object.keys(this.textures).length}/844`,
            () => `GRID: S ${this.getGridSpacing()}`,
            () => `CLAIMS: [${this.stats.claims_rendered > 0 ? "HIGH" : "LOW" }] ${this.stats.claims_rendered}/${Object.keys(this.claims).length}`,
            () => `POINTER: ${this.pointer.onscreen} ${this.pointer.x} ${this.pointer.y} ${this.pointer.m1}`,
            () => `HOVER: C ${this.stats.candidates}/${this.stats.quadtree_content} H: ${this.hovered_claim}`,
            () => `SEARCH: ${this.last_search.length} ${this.search_index}`,
            () => `SELECTION: ${this.lazy_update_rect_selection} ${this.rect_selection}`,
            () => `HANDLES: ${this.hovered_handle} ${this.held_handle} ${this.handles.length}`
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
        this.app.stage.addChild(this.claim_high_res_group)
        this.app.stage.addChild(this.claim_low_res)
        this.app.stage.addChild(this.grid_graphics)
        this.app.stage.addChild(this.block_selection_graphics)
        this.app.stage.addChild(this.rect_selection_graphics)
        this.app.stage.addChild(this.block_hover)
        this.app.stage.addChild(this.tooltip_containter)
        this.app.stage.addChild(this.annotation_layer)
        this.app.stage.addChild(debug_container)
    
        
        this.app.ticker.add((ticker) => {
            this.tick()

            if (debug_container.visible) {
                debug_container.y = document.body.clientHeight - 22 * debug_lines.length
                debug_lines.forEach(line => line())
            }

            this.clock += ticker.deltaTime
        })

        this.loadParams()
    }

    createAnnotations() {
        const annotation = new Annotations(this)

        this.annotation_layer.addChild(annotation.container)

        this.annotations.push(annotation)

        let test = []
        
        for (let i = 0; i < 20; i++) {
            test.push([
                Math.cos(i / 10 * Math.PI) * 100,
                Math.sin(i / 10 * Math.PI) * 100,
            ])
        }

        let poly = new PolygonAnnotation(test)
        
        annotation.addAnnotation(poly)

        poly.createHandles()

        return annotation
    }

    tick() {
        const perf_begin = performance.now()

        this._derived_zoom = Math.pow(1.1, this.state.zoom)

        
        const screenWidth = document.body.clientWidth
        const screenHeight = document.body.clientHeight
        
        if (document.activeElement != x_input) x_input.value = Math.floor(this.state.x)
        if (document.activeElement != z_input) z_input.value = Math.floor(this.state.z)
            
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

        const map_tile_sprites = this.allocateSprites(this.map_tile_sprite_pool, tiles)

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

                    const sprite = map_tile_sprites.pop()

                    if (sprite == undefined) break

                    const screenSpace = this.toScreenSpace([
                        global_tile_x * sizeOfTileBlocks,
                        global_tile_z * sizeOfTileBlocks
                    ])

                    const tile_id = `${lod}/${global_tile_x}/${global_tile_z}`

                    sprite.name = tile_id

                    let children_drawn = this.children_cache[tile_id] || false

                    children_drawn = true

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
                            
                        if (this.debug) {
                            switch (lod) {
                                case 0:
                                    sprite.tint = 0xFF6666
                                    break
                                case 1:
                                    sprite.tint = 0x66FF66
                                    break
                                case 2:
                                    sprite.tint = 0x6666FF
                                    break
                            }
                        }
                    } else {
                        sprite.visible = false
                        this.load_tile(this.state.map, this._derived_lod, global_tile_x, global_tile_z)
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
            const linesAcrossHeight = screenHeight / grid_pixel_size + 1

            for (let column = 0; column < linesAcrossWidth; column++) {
                this.grid_graphics.moveTo(grid_screen_origin[0] + column * grid_pixel_size, 0).lineTo(grid_screen_origin[0] + column * grid_pixel_size, screenHeight)
                
            }
            this.grid_graphics.stroke({ color: 0x777777, pixelLine: true })

            for (let row = 0; row < linesAcrossHeight; row++) {
                this.grid_graphics.moveTo(0, grid_screen_origin[1] + row * grid_pixel_size).lineTo(screenWidth, grid_screen_origin[1] + row * grid_pixel_size)
                
            }
            this.grid_graphics.stroke({ color: 0x555555, pixelLine: true })
        }

        let pointer_world_pos = this.toWorldSpace([this.pointer.x, this.pointer.y])

        let pointer_candidates = this._last_candidates

        if (this.pointer.hasMoved && this.pointer.onscreen) {
            pointer_candidates = new Set(this.claim_quadtree.retrieve({
                x: pointer_world_pos[0],
                y: pointer_world_pos[1],
                width: 1,
                height: 1,
            }).map(x => x.id))

            this._last_candidates = pointer_candidates
        }

        this.stats.candidates = pointer_candidates.size

        this.tooltip_containter.x = this.pointer.x + 8
        this.tooltip_containter.y = this.pointer.y + 4

        if (!this.lazy_update) {
            this.tooltip_text.text = `<strong>${Math.floor(pointer_world_pos[0])} ${Math.floor(pointer_world_pos[1])}</strong>  `
        }

        let claims_rendered = 0
        let anyHovered = this.lazy_update

        if (this._derived_lod > 0) {
            let low_res_origin = this.toScreenSpace([0, 0])
            this.claim_low_res.x = low_res_origin[0]
            this.claim_low_res.y = low_res_origin[1]
            this.claim_low_res.scale = this._derived_zoom / (this.config.claims_low_res / this.config.tile_size / this.config.depth)
            this.claim_low_res.visible = true

            this.claim_high_res_group.visible = false
        } else if (!this.lazy_update) {
            this.claim_low_res.visible = false
            this.claim_high_res_group.visible = true

            this.lazy_update = true

            const renderable = {}

            for (const [id, claim] of Object.entries(this.claims)) {
                const bounding_box = this.getClaimBounds(id).map(x => this.toScreenSpace(x))

                if (
                    bounding_box[1][0] < 0 ||
                    bounding_box[0][0] > screenWidth ||
                    bounding_box[1][1] < 0 |
                    bounding_box[0][1] > screenHeight
                ) {
                    const dead_graphics = this.claim_graphics[id]

                    if (dead_graphics) {
                        // TODO: Cleanup old instances
                        dead_graphics.visible = false
                    }

                    continue
                }

                renderable[id] = bounding_box
            }

            for (const [id, bounds] of Object.entries(renderable)) {
                let graphics = this.claim_graphics[id]

                let shouldRedraw = this.hovered_claim == id || this.focused_claim == id || this.force_claim_redraw

                if (graphics == undefined) {
                    graphics = new PIXI.Graphics()
                    graphics.name = id

                    shouldRedraw = true

                    this.claim_high_res_group.addChild(graphics)

                    this.claim_graphics[id] = graphics
                }

                if (this.hovered_claim == id) {
                    shouldRedraw = true
                }

                if (pointer_candidates.has(id)) {
                    shouldRedraw = true
                }

                if (shouldRedraw) {
                    let path = this.claim_path[id]

                    const world_bounds = this.getClaimBounds(id)

                    if (path == undefined) {
                        let points = []
                        
                        this.claims[id].shape.forEach(point => {
                            points.push((point.x - world_bounds[0][0]) / 16)
                            points.push((point.z - world_bounds[0][1]) / 16)
                        })

                        path = new PIXI.GraphicsPath().moveTo(points[0], points[1])

                        for (let i = 2; i < points.length; i+=2) {
                            path.lineTo(points[i], points[i + 1])
                        }

                        path.closePath()

                        this.claim_path[id] = path
                    }

                    let clr = this.rgbToInt(
                        this.claims[id].fillColor.r,
                        this.claims[id].fillColor.g,
                        this.claims[id].fillColor.b
                    )
                    let blend = "inherit"

                    if (pointer_candidates.has(id)) {
                        if (
                            pointer_world_pos[0] > world_bounds[0][0] &&
                            pointer_world_pos[0] < world_bounds[1][0] &&
                            pointer_world_pos[1] > world_bounds[0][1] &&
                            pointer_world_pos[1] < world_bounds[1][1]
                        ) {
                            // TODO: derive from previous calculation
                            let points = []
                        
                            this.claims[id].shape.forEach(point => {
                                points.push(point.x)
                                points.push(point.z)
                            })

                            const polygon = new PIXI.Polygon(points)

                            if (polygon.contains(pointer_world_pos[0], pointer_world_pos[1])) {
                                this.hovered_claim = id
                                anyHovered = true
                                this.force_claim_redraw = true
                            }
                        }
                    }

                    if (this.hovered_claim == id) {
                        clr = 0x11CCCC
                        blend = "divide"
                    }

                    if (this.focused_claim == id) {
                        clr = 0xFF7700
                    }
                
                    graphics.clear()
                    graphics.path(path, new PIXI.Matrix(1, 0, 0, 1, 100, 100))
                    graphics.blendMode = blend
                    
                    if (this.state.zoom < 10) {
                        let a = Math.max(0, Math.min(0.6, 1 / (this.state.zoom + 1.7)) - 0.1)

                        if (this.state.zoom < 0) a = 0.5

                        graphics.fill({
                            color: clr,
                            alpha: a
                        })
                    }

                    graphics.stroke({
                        color: clr,
                        alpha: 0.5,
                        width: 1/16
                    }, path)
                }

                claims_rendered++
                
                graphics.x = bounds[0][0] + this._derived_zoom / 2
                graphics.y = bounds[0][1] + this._derived_zoom / 2
                graphics.width = (bounds[1][0] - bounds[0][0])
                graphics.height = (bounds[1][1] - bounds[0][1])
                graphics.visible = true
            }
        }

        if (!anyHovered) {
            this.hovered_claim = undefined
        }

        this.annotations.forEach(annotation => annotation.tick(screenWidth, screenHeight))

        if (this._derived_lod == 0) {
            this.block_hover.visible = true
            
            // TODO: cull offscreen

            const block_scale = this._derived_zoom / this.config.block_selection_stroke
            const hoveredBlockPos = this.toScreenSpace(pointer_world_pos.map(Math.floor))

            this.block_hover.x = hoveredBlockPos[0]
            this.block_hover.y = hoveredBlockPos[1]
            this.block_hover.scale = block_scale
            
            if (this.state.selected_block) {
                const selectedScreenPos = this.toScreenSpace([this.state.selected_block.x, this.state.selected_block.z])
                
                this.block_selection_graphics.x = selectedScreenPos[0]
                this.block_selection_graphics.y = selectedScreenPos[1]
                this.block_selection_graphics.scale = block_scale

                this.block_selection_graphics.visible = true
            } else {
                this.block_selection_graphics.visible = false
            }


            if (this.rect_selection != undefined) {
                const [x1, z1, x2, z2] = this.rect_selection

                const blockWidth = x2 - x1 + 1
                const blockHeight = z2 - z1 + 1

                
                if (!this.lazy_update_rect_selection) {
                    this.rect_selection_graphics.clear()

                    this.rect_selection_graphics.moveTo(0, 0)
                        .lineTo(blockWidth * this.config.block_selection_stroke, 0)
                        .lineTo(blockWidth * this.config.block_selection_stroke, blockHeight * this.config.block_selection_stroke)
                        .lineTo(0, blockHeight * this.config.block_selection_stroke)
                        .closePath()
                        .stroke({ color: 0x777777, width: this.config.block_selection_stroke })


                    this.lazy_update_rect_selection = true
                }
                
                const [origin_x, origin_z] = this.toScreenSpace([x1, z1])
                
                this.rect_selection_graphics.x = origin_x + this._derived_zoom / 2
                this.rect_selection_graphics.y = origin_z + this._derived_zoom / 2
                this.rect_selection_graphics.width = blockWidth * this._derived_zoom
                this.rect_selection_graphics.height = blockHeight * this._derived_zoom
                
                this.rect_selection_graphics.visible = true
                
            } else {
                this.rect_selection_graphics.visible = false
            }
        } else {
            this.block_selection_graphics.visible = false
            this.block_hover.visible = false
        }

        this.handles.forEach(x => x.tick(screenWidth, screenHeight))

        this.stats.claims_rendered = claims_rendered

        this.stats.frametime = performance.now() - perf_begin
        this.force_claim_redraw = false
    }

    rgbToInt(r, g, b) {
        return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
    }

    teleport(state) {
        Object.assign(this.state, state)
        this.lazy_update = false
        this.force_claim_redraw = true
    }

    getGridSpacing() {
        if (this.state.zoom >= 30) {
            return 1
        } else if (this.state.zoom >= 10) {
            return 16
        }
    }

    getHoveredHandle(pointer_pos) {
        for (let i = 0; i < this.handles.length; i++) {
            const handle = this.handles[i]

            const screen = this.toScreenSpace(handle.world_pos)

            if (manhattanDistance(pointer_pos, screen) < Handle.HANDLE_SIZE) {
                return handle
            }
        }
    }

    setFocusedClaim(id) {
        this.focused_claim = id

        if (id && this.claims[id]) {
            const claim = this.claims[id]

            claim_panel_name.innerHTML = claim.name
            claim_panel_owner.innerHTML = `Owned by ${claim.players[0]}`
            claim_panel_balance.innerHTML = `: $${claim.balance} (${claim.players.length} players)`

            claim_panel_flag.src = "assets/flag_temp.png"
            claim_panel_owner_model.src = ""
            claim_panel_owner_model.src = `https://mc-heads.net/body/${claim.players[0]}/left`

            claim_panel.style.display = ""
            claim_button_container.style.display = ""

            const header = document.createElement("tr")
            const player_header = document.createElement("th")
            player_header.innerText = "PLAYER"
            header.appendChild(player_header)

            const rank_header = document.createElement("th")
            rank_header.innerText = "PLAYER"
            header.appendChild(rank_header)

            const tier_header = document.createElement("th")
            tier_header.innerText = "TIER"
            header.appendChild(tier_header)


            let children = [
                header
            ]

            let index = 0
            claim.players.forEach(player => {
                if (player == "<unknown>" || player == "...") {
                    index = -1
                    return
                }

                const row = document.createElement("tr")
                const player_label = document.createElement("td")
                player_label.innerText = player
                row.appendChild(player_label)

                const rank_label = document.createElement("td")
                rank_label.innerText = index == 0 ? "owner" : "member"
                row.appendChild(rank_label)

                const tier_label = document.createElement("td")
                tier_label.innerText = "unknown"
                row.appendChild(tier_label)
                
                children.push(row)

                index++
            })

            if (index == -1) {
                const footer = document.createElement("tr")
                const player_footer = document.createElement("td")
                player_footer.innerText = "..."
                footer.appendChild(player_footer)

                const rank_footer = document.createElement("td")
                rank_footer.innerText = "..."
                footer.appendChild(rank_footer)

                const tier_footer = document.createElement("td")
                tier_footer.innerText = "..."
                footer.appendChild(tier_footer)

                children.push(footer)
            }

            claim_panel_players.replaceChildren(...children)

            // this.teleport({
            //     x: claim.position.x,w
            //     z: claim.position.z,
            //     zoom: 1
            // })

        } else {
            claim_panel.style.display = "none"
            claim_button_container.style.display = "none"

        }
    }

    registerEvents() {
        let mouseStartX = 0
        let mouseStartY = 0
        let dragging = false

        let mapStartX = 0
        let mapStartY = 0

        x_input.addEventListener("focus", () => x_input.select())
        z_input.addEventListener("focus", () => z_input.select())

        x_input.addEventListener("input", event => {
            const x = parseInt(x_input.value)
            if (x) {
                this.state.x = x
                this.lazy_update = false
            }
        })
        z_input.addEventListener("input", event => {
            const z = parseInt(z_input.value)
            if (z) {
                this.state.x = z
                this.lazy_update = false
            }
        })

        this.app.canvas.addEventListener("contextmenu", e => {
            e.preventDefault()
        })

        window.addEventListener("keydown", event => {
            if (/^[a-zA-Z.]{1}$/.test(event.key) && search_span != document.activeElement && !(event.ctrlKey)) {
                search_span.innerText = ""
                search_span.focus()
            }
        })

        search_span.addEventListener('keydown', (e) => {
            if (e.key == 'Enter') {
                e.preventDefault()
                search_span.innerText = ""

                if (this.last_search.length > 0) {
                    this.setFocusedClaim(this.last_search.at(-this.search_index - 1).claim)
                }
            }

            if (e.key == 'Tab') {
                e.preventDefault()
                let cycle = Math.min(this.config.search_preview, this.last_search.length)

                this.search_index = (this.search_index + cycle - 1) % cycle
            }

            if (e.key == 'ArrowUp') {
                e.preventDefault()
                let cycle = Math.min(this.config.search_preview, this.last_search.length)

                this.search_index = (this.search_index + cycle + 1) % cycle
            }
            
            if (e.key == 'ArrowDown') {
                e.preventDefault()
                let cycle = Math.min(this.config.search_preview, this.last_search.length)

                this.search_index = (this.search_index + cycle - 1) % cycle
            }

            if (e.key == 'Backspace' && search_span.innerText.length == 1) {
                search_span.blur()
                search_span.innerText = ""
                this.updateSearch("")
            }

            if (e.key == "Escape") {
                // What the fuck where they thinking when they named this
                search_span.blur()
                search_span.innerText = ""
                this.updateSearch("")
            }
        })

        let block_pos_down = [0, 0]
        let screen_pos_down = [0, 0]
        window.addEventListener("pointerup", event => {

            if (screen_pos_down[0] == event.clientX && screen_pos_down[1] == event.clientY && event.button == 0) {
                this.state.selected_block = {
                    x: block_pos_down[0],
                    z: block_pos_down[1]
                }
            }

            const block_pos_up = this.toWorldSpace([event.clientX, event.clientY]).map(Math.floor)

            if (block_pos_up[0] == block_pos_down[0] && block_pos_up[1] == block_pos_down[1]) {
                if (event.button == 2) {
                    context_menu.style.display = "block"
                    context_menu.style.left = `${event.clientX - 2}px`
                    context_menu.style.top = `${event.clientY - 16}px`
                    event.preventDefault()
                }
            }

            this.saveParams()
        })

        window.addEventListener("pointerdown", event => {
            block_pos_down = this.toWorldSpace([event.clientX, event.clientY]).map(Math.floor)
            screen_pos_down = [event.clientX, event.clientY]

            if (event.target) {
                if (event.target.parentElement == search_results) {
                    const id = event.target.id.split("_")[1]

                    this.setFocusedClaim(id)

                    search_span.blur()
                    search_span.textContent = ""

                    this.updateSearch("")
                } else if (event.target.parentElement.parentElement == search_results) {
                    const id = event.target.parentElement.id.split("_")[1]

                    this.setFocusedClaim(id)
                    
                    search_span.blur()
                    search_span.textContent = ""
                    
                    this.updateSearch("")
                }
            }
        })

        search_span.addEventListener("keyup", (e) => {
            if (search_span == document.activeElement) {
                this.updateSearch(search_span.innerText)
            }
        })

        window.addEventListener("pointermove", event => {
            this.pointer.x = event.clientX
            this.pointer.y = event.clientY
            this.pointer.hasMoved = true
        })

        document.addEventListener("mouseenter", event => {
            if (event.target != this.app.canvas) return
            this.pointer.onscreen = true
        })


        document.addEventListener("mouseleave", event => {
            if (event.target != this.app.canvas) return
            this.pointer.onscreen = false
        })

        let selecting = false
        let selecting_block_pos_begin_x = 0
        let selecting_block_pos_begin_z = 0

        let handling = false

        window.addEventListener("mousedown", event => {
            if (event.target != this.app.canvas) return

            const [wx, wz] = this.toScreenSpace([
                event.clientX,
                event.clientY
            ])

            if (event.button == 0) {
                const handle = this.getHoveredHandle([
                    event.clientX,
                    event.clientY
                ])

                if (handle) {

                    this.held_handle = handle

                    handling = true
                } else {
                    if (this.hovered_claim != undefined) {
                        this.setFocusedClaim(this.hovered_claim)
                    }
                    mouseStartX = event.x
                    mouseStartY = event.y
                    dragging = true

                    mapStartX = this.state.x
                    mapStartY = this.state.z
                }
            } else if (event.button == 2) {
                [selecting_block_pos_begin_x, selecting_block_pos_begin_z] = this.toWorldSpace([event.clientX, event.clientY]).map(Math.floor)
                selecting = true
            }

            this.lazy_update = false
        })

        window.addEventListener("mousemove", event => {

            this.hovered_handle = this.getHoveredHandle([
                event.clientX,
                event.clientY
            ])

            const [wx, wz] = this.toWorldSpace([event.clientX, event.clientY]).map(Math.round)

            if (dragging) {
                const delta_x = (mouseStartX - event.x) / this._derived_zoom
                const delta_y = (mouseStartY - event.y) / this._derived_zoom

                this.state.x = mapStartX + delta_x
                this.state.z = mapStartY + delta_y
            }

            if (handling) {
                this.held_handle.update([wx, wz])
            }

            if (selecting) {

                this.lazy_update_rect_selection = false
                this.rect_selection = [
                    Math.min(wx, selecting_block_pos_begin_x),
                    Math.min(wz, selecting_block_pos_begin_z),
                    Math.max(wx, selecting_block_pos_begin_x),
                    Math.max(wz, selecting_block_pos_begin_z),
                ]
            }

            this.lazy_update = false
        })

        window.addEventListener("mouseup", event => {
            if (event.button == 0 && dragging) {
                dragging = false

                this.lazy_update = false
            } else if (event.button == 0 && handling) {
                handling = false
            } else if (event.button == 2 && selecting) {
                selecting = false

                this.lazy_update_rect_selection = false
                
                if (this.active_annotation) {
                    const [x1, z1, x2, z2] = this.rect_selection

                    if (x2 - x1 < 2 && z2 - z1 < 2) {
                        const annotation = new RectangleAnnotation([x1, z1], [x2 + 1, z2 + 1])

                        this.active_annotation.addAnnotation(annotation)
                        
                        annotation.createHandles()
                    }
                }

                this.rect_selection = undefined
                selecting_block_pos_begin_x = 0
                selecting_block_pos_begin_z = 0
            }
        })

        window.addEventListener("wheel", event => {
            this.state.zoom = Math.max(this.config.min_zoom, Math.min(this.config.max_zoom, this.state.zoom - event.deltaY / 100))

            this.lazy_update = false
        })

        let zooming = false
        let initial_zoom = 0
        let initial_touch_delta = 0

        let last_touch = 0

        window.addEventListener("touchstart", event => {
            this.pointer.onscreen = true


            if (event.touches.length == 2 && event.target == this.app.canvas) {
                zooming = true
                initial_zoom = this.state.zoom

                const dx = event.touches[0].screenX - event.touches[1].screenX
                const dy = event.touches[0].screenY - event.touches[1].screenY

                initial_touch_delta = Math.sqrt(
                    dx * dx + dy * dy
                )
            } else if (event.touches.length == 1) {
                if (last_touch > Date.now() - 300) {
                    if (this.hovered_claim) {
                        this.setFocusedClaim(this.hovered_claim)
                        event.preventDefault()
                    }
                }
                last_touch = Date.now()
            }

            if (event.target == this.app.canvas) {
                mouseStartX = event.touches[0].screenX
                mouseStartY = event.touches[0].screenY
                dragging = true

                mapStartX = this.state.x
                mapStartY = this.state.z

                this.lazy_update = false
            }

            
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

            this.lazy_update = false
		})

        window.addEventListener("touchend", event => {
            this.pointer.onscreen = false

            zooming = false
            dragging = false

            this.lazy_update = false
		})

        context_menu.addEventListener("pointerleave", event => {
            context_menu.style.display = "none"
        })

        claim_deselect.addEventListener("click", event => {
            this.setFocusedClaim(undefined)
        })

        claim_teleport.addEventListener("click", event => {
            const claim = this.claims[this.focused_claim]

            if (claim) {
                this.state.x = claim.position.x
                this.state.z = claim.position.z
                this.state.zoom = 6
            }

            this.saveParams()
        })

        claim_share.addEventListener("click", event => {
            const claim = this.claims[this.focused_claim]

            const prev_content = claim_share.innerHTML

            if (claim) {
                const url = new URL(window.location)
                url.search = ""

                url.searchParams.set("claim", claim.name)
                
                navigator.clipboard.writeText(url.toString())

                claim_share.innerHTML = "Copied"

                setTimeout(() => {
                    claim_share.innerHTML = prev_content
                }, 500)
            }
        })

        context_copy.addEventListener("click", event => {
            if (context_copy.innerText == "Copied") return
            
            const worldPos = this.toWorldSpace([this.pointer.x, this.pointer.y])
            
            const prev_content = context_copy.innerHTML

            navigator.clipboard.writeText(`(${Math.floor(worldPos[0])}, ${Math.floor(worldPos[1])})`)

            context_copy.innerHTML = "Copied"

            setTimeout(() => {
                context_copy.innerHTML = prev_content
            }, 500)
        })

        context_copy_link.addEventListener("click", event => {
            if (context_copy_link.innerText == "Copied") return
            
            const worldPos = this.toWorldSpace([this.pointer.x, this.pointer.y])
            
            const prev_content = context_copy_link.innerHTML

             const url = new URL(window.location)
            url.search = ""

            url.searchParams.set("s", [...worldPos.map(Math.floor), 6].join("_"))

            navigator.clipboard.writeText(url.toString())

            context_copy_link.innerHTML = "Copied"

            setTimeout(() => {
                context_copy_link.innerHTML = prev_content
            }, 500)
        })

        claim_panel.addEventListener('wheel', (e) => {
            const { scrollTop, scrollHeight, clientHeight } = claim_panel
            const delta = e.deltaY

            if (delta < 0 && scrollTop === 0) {
                e.preventDefault()
                return
            }

            if (delta > 0 && scrollTop + clientHeight >= scrollHeight) {
                e.preventDefault()
                return
            }

            e.stopPropagation()
        }, { passive: false })
    }

    pullMatchingSubstring(str, substring) {
        const index = str.toLowerCase().indexOf(substring.toLowerCase())

        if (index === -1) {
            return false
        }

        return [
            str.substring(0, index),
            str.substring(index, index + substring.length),
            str.substring(index + substring.length)
        ]
    }

    saveParams() {
        const url = new URL(window.location)
        
        url.search = ""

        url.searchParams.set("s", [
            Math.floor(this.state.x),
            Math.floor(this.state.z),
            Math.floor(this.state.zoom)
        ].join("_"))

        if (this.state.map != "undefined") {
            url.searchParams.set("map", this.state.map)
        }

        window.history.replaceState({}, '', url)
    }

    loadParams() {
        const params = new URLSearchParams(window.location.search);

        const state_updates = {
            "s": [s => s.split("_"), s => {
                
                if (s.includes("NaN")) return

                if (s.length == 3) {
                    this.teleport({
                        x: parseInt(s[0]),
                        z: parseInt(s[1]),
                        zoom: parseInt(s[2])
                    })
                }
            }],
            "map": [map => map, map => {
                this.data_promise.then(() => {
                    if (this.meta.maps[map]) {
                        this.load_map(map)
                        this.update_map_ui(map)
                    }
                })
            }]
        }

        for (const [key, [transformer, update]] of Object.entries(state_updates)) {
            const v = params.get(key)

            if (v == undefined) continue

            try {
                const transformed_value = transformer(v)

                update(transformed_value)
            } catch (e) {
                console.warn(`Failed to load parameter ${key} "${params.get(key)}"\n`, e)
            }
        }

        if (params.has("claim")) {
            this.data_promise.then(() => {
                const claim_name = params.get("claim")
                const claim_id = this.claim_name_lookup[claim_name]
                if (claim_id) {
                    const claim = this.claims[claim_id]
                    
                    if (claim) {
                        this.teleport({
                            x: claim.position.x,
                            z: claim.position.z,
                            zoom: 6
                        })

                        this.setFocusedClaim(claim_id)

                        this.force_claim_redraw = true
                    }
                }
            })
        }

        this.saveParams()
    }

    updateSearch(text) {
        const matches = []

        if (text.length > 0) {
            for (const [id, claim] of Object.entries(this.claims)) {
                const name_match = this.pullMatchingSubstring(claim.name, text)

                if (name_match !== false) {
                    const parent = document.createElement("span")

                    parent.id = `searchresult-claim-${claim.name}_${id}`

                    parent.appendChild(document.createTextNode(name_match[0]))
                    
                    const match_span = document.createElement("span")
                    match_span.innerHTML = name_match[1]
                    parent.appendChild(match_span)

                    parent.appendChild(document.createTextNode(name_match[2]))

                    matches.push({
                        score: 1 / claim.name.length * 10,
                        claim: id,
                        child: parent
                    })
                }

                if (claim.owning_nation) {
                    const nation_match = this.pullMatchingSubstring(claim.owning_nation, text)

                    if (nation_match !== false) {
                        const parent = document.createElement("span")

                        parent.id = `searchresult-claim-${claim.name}-${claim.owning_nation}_${id}`

                        parent.appendChild(document.createTextNode(claim.name + " ["))
                        parent.appendChild(document.createTextNode(nation_match[0]))
                        
                        const match_span = document.createElement("span")
                        match_span.innerHTML = nation_match[1]
                        parent.appendChild(match_span)

                        parent.appendChild(document.createTextNode(nation_match[2] + "]"))

                        matches.push({
                            score: 1 / claim.name.length + 1 / claim.owning_nation.length * 0.5,
                            claim: id,
                            child: parent
                        })
                    }
                }

                claim.players.forEach(name => {
                    if (name == "<unknown>") return
                    if (name == "...") return

                    const player_match = this.pullMatchingSubstring(name, text)

                    if (player_match !== false) {
                        const parent = document.createElement("span")

                        parent.id = `searchresult-claim-${claim.name}-${name}_${id}`

                        parent.appendChild(document.createTextNode(claim.name + " ["))
                        parent.appendChild(document.createTextNode(player_match[0]))
                        
                        const match_span = document.createElement("span")
                        match_span.innerHTML = player_match[1]
                        parent.appendChild(match_span)

                        parent.appendChild(document.createTextNode(player_match[2] + "]"))

                        matches.push({
                            score: 1 / claim.name.length + 1 / name.length * 0.75,
                            claim: id,
                            child: parent
                        })
                    }
                })
            }
        }

        if (matches.length > 0) {
            matches.sort((a, b) => a.score - b.score)

            this.search_index = Math.min(this.search_index, this.config.search_preview)

            matches.at(-this.search_index - 1).child.style.background = "rgb(255, 255, 255, 0.3)"
        } else {
            this.search_index = 0
        }

        this.last_search = matches
        search_results.replaceChildren(...matches.map(x => x.child).slice(-this.config.search_preview))
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
        let max_x = -9e9
        let max_z = -9e9

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

    allocateSprites(pool, count) {
        let sprites = []
        let head = 0

        while (sprites.length < count) {
            if (head >= pool.length) {
                const sprite = PIXI.Sprite.from("sample.png")

                this.map_root.addChild(sprite)

                pool.push(sprite)
            }

            sprites.push(pool[head])
            head++

            if (head > this.config.max_sprites) break
        }

        for (let i = head; i < pool.length; i++) {
            const sprite = pool[i]

            sprite.visible = false
            sprite.texture = this.textures["sample"]
        }

        return sprites
    }

    toScreenSpace([wx, wz]) {
        const halfWidth = this.app.renderer.screen.width / 2
        const halfHeight = this.app.renderer.screen.height / 2

        return [
            (wx - this.state.x) * this._derived_zoom + halfWidth,
            (wz - this.state.z) * this._derived_zoom + halfHeight
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
    max_zoom: 50,
    search_preview: 10,
    initial_map: "bluemap",
    block_selection_stroke: 16,
    texture_ttl: 5000 // i have no idea how this fixed it
})
await WorldMap.instance.init()
globalThis.__PIXI_APP__ = WorldMap.instance.app

