class Map  {

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
    }

    async load_map(id) {
        const root_path = `static/${id}`
        const depth = this.config.depth

        for (let lod = this.config.lod - 1; lod > -1; lod--) {

            let relative_depth = depth / Math.pow(2, lod)

            console.log(relative_depth)

            for (let x = -relative_depth; x <= relative_depth; x++) {
                for (let z = -relative_depth; z <= relative_depth; z++) {
                    await PIXI.Assets.load(`${root_path}/${lod}/${z}/${x}.png`).then(texture => {
                        this.textures[`${lod}/${x}/${z}`] = texture
                    }).catch(() => {})
                }
            }
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
        debug_container.zIndex = 1

        let debug_lines = [
            () => `[DEBUG] Community Dynmap Reborn ${Map.VERSION}`,
            () => `FPS: ${this.app.ticker.FPS.toFixed(1)} (VSYNC)`,
            () => `T: ${this.stats.tiles_rendered} P: ${this.sprite_pool.length}`,
            () => `POS: ${Math.round(this.state.x)} ${Math.round(this.state.z)} ZOOM: ${this.state.zoom}`,
            () => `LOD: ${this._derived_lod} SF: ${Math.floor(this._derived_zoom * 100) / 100}`,
            () => `CHILDREN: ${Object.keys(this.children_cache).length}`,
            () => `LOADED: ${Object.keys(this.textures).length}/844`
        ]

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
        
        this.app.stage.addChild(this.map_root)
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

                    if (Math.abs(global_tile_x) > this.config.depth) continue
                    if (Math.abs(global_tile_z) > this.config.depth) continue

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

                    if (Math.abs(global_tile_x) > this.config.depth) continue
                    if (Math.abs(global_tile_z) > this.config.depth) continue

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
    }

    registerEvents() {
        let mouseStartX = 0
        let mouseStartY = 0
        let held = false

        let mapStartX = 0
        let mapStartY = 0

        window.addEventListener("pointerdown", event => {
            mouseStartX = event.x
            mouseStartY = event.y
            held = true

            mapStartX = this.state.x
            mapStartY = this.state.z
        })

        window.addEventListener("pointermove", event => {
            if (held) {
                const delta_x = (mouseStartX - event.x) / this._derived_zoom
                const delta_y = (mouseStartY - event.y) / this._derived_zoom

                this.state.x = mapStartX + delta_x
                this.state.z = mapStartY + delta_y
            }
        })

        window.addEventListener("pointerup", event => {
            held = false
        })

        window.addEventListener("wheel", event => {
            this.state.zoom += -event.deltaY / 100
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
            (wx - this.state.x - halfWidth) * this._derived_zoom + halfWidth,
            (wz - this.state.z - halfHeight) * this._derived_zoom + halfHeight
        ];
    }

    toWorldSpace([sx, sy]) {
        const halfWidth = this.app.renderer.screen.width / 2;
        const halfHeight = this.app.renderer.screen.height / 2;
        return [
            (sx - halfWidth) / this._derived_zoom + this.state.x + halfWidth,
            (sy - halfHeight) / this._derived_zoom + this.state.z + halfHeight
        ];
    }
}

// Put this shit in the documentation, jesus fucking christ
// Like how the actual fuck am I supposed to figure this shit out without reading the source code
PIXI.TextureSource.defaultOptions.scaleMode = 'nearest';
PIXI.AbstractRenderer.defaultOptions.roundPixels = true;

Map.instance = new Map({
    tile_size: 1024,
    depth: 12,
    lod: 3,
    max_sprites: 200
})
await Map.instance.init()
globalThis.__PIXI_APP__ = Map.instance.app

