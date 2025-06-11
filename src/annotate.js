
function isBoxOnscreen(box, screenWidth, screenHeight) {
    if (box[1][0] < 0) return false
    if (box[1][1] < 0) return false
    if (box[0][0] > screenWidth) return false
    if (box[0][1] > screenHeight) return false

    return true
}

export class RectangleAnnotation {

    name = "Rectangle"

    path = undefined
    bounds = undefined

    stale = false

    constructor([x1, y1], [x2, y2]) {
        this.updatePath([x1, y1], [x2, y2])
    }

    #expandBounds([x, y]) {
        if (this.bounds == null) this.bounds = [[9e9, 9e9], [-9e9, -9e9]]

        this.bounds[0][0] = Math.min(this.bounds[0][0], x)
        this.bounds[0][1] = Math.min(this.bounds[0][0], y)
        this.bounds[1][0] = Math.max(this.bounds[0][0], x)
        this.bounds[1][1] = Math.max(this.bounds[0][0], y)
    }

    updatePath([x1, y1], [x2, y2]) {
        this.path = new PIXI.GraphicsPath()
            .moveTo(x1, y1)
            .lineTo(x2, y1)
            .lineTo(x2, y2)
            .lineTo(x1, y2)
            .closePath()

        this.#expandBounds([
            this.path.shapePath.bounds.left,
            this.path.shapePath.bounds.top,
        ])

        this.#expandBounds([
            this.path.shapePath.bounds.right,
            this.path.shapePath.bounds.bottom,
        ])
        this.stale = true
    }
}

export class PolygonAnnotation {

    name = "Polygon"

    path = undefined
    bounds = undefined

    stale = false

    constructor([x1, y1], [x2, y2]) {
        this.updatePath([x1, y1], [x2, y2])
    }

    #expandBounds([x, y]) {
        if (this.bounds == null) this.bounds = [[9e9, 9e9], [-9e9, -9e9]]

        this.bounds[0][0] = Math.min(this.bounds[0][0], x)
        this.bounds[0][1] = Math.min(this.bounds[0][0], y)
        this.bounds[1][0] = Math.max(this.bounds[0][0], x)
        this.bounds[1][1] = Math.max(this.bounds[0][0], y)
    }

    updatePath([x1, y1], [x2, y2]) {
        this.path = new PIXI.GraphicsPath()
            .moveTo(x1, y1)
            .lineTo(x2, y1)
            .lineTo(x2, y2)
            .lineTo(x1, y2)
            .closePath()

        this.#expandBounds([
            this.path.shapePath.bounds.left,
            this.path.shapePath.bounds.top,
        ])

        this.#expandBounds([
            this.path.shapePath.bounds.right,
            this.path.shapePath.bounds.bottom,
        ])
        this.stale = true
    }
}

export class Annotations {
    static RESOLUTION = 16

    resolution = Annotations.RESOLUTION

    annotations = {}
    world_bounds = null
    
    derived_width = 0
    derived_height = 0
    
    graphics = {}

    container = new PIXI.Container()

    constructor(worldMap) {
        this.worldMap = worldMap
    }

    #expandBounds([x, y]) {
        if (this.world_bounds == null) this.world_bounds = [[Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE]]

        this.world_bounds[0][0] = Math.min(this.world_bounds[0][0], x)
        this.world_bounds[0][1] = Math.min(this.world_bounds[0][0], y)
        this.world_bounds[1][0] = Math.max(this.world_bounds[0][0], x)
        this.world_bounds[1][1] = Math.max(this.world_bounds[0][0], y)

        this.derived_width = this.world_bounds[1][0] - this.world_bounds[0][0]
        this.derived_height = this.world_bounds[1][1] - this.world_bounds[0][1]
    }

    addAnnotation(path) {
        const id = crypto.randomUUID()

        this.#expandBounds(path.bounds[0])
        this.#expandBounds(path.bounds[1])

        this.annotations[id] = path

        return id
    }

    tick(screenWidth, screenHeight) {
        if (this.world_bounds == null) return

        const screenBounds = this.world_bounds.map(pos => this.worldMap.toScreenSpace(pos))

        if (isBoxOnscreen(screenBounds, screenWidth, screenHeight)) {
            const world_origin_screen = this.worldMap.toScreenSpace([0, 0]) // TODO: cascade this down?

            for (const [id, annotation] of Object.entries(this.annotations)) {

                if (!isBoxOnscreen(annotation.bounds.map(pos => this.worldMap.toScreenSpace(pos)), screenWidth, screenHeight)) continue

                let graphic = this.graphics[id]

                if (graphic == undefined) {
                    graphic = new PIXI.Graphics()
                    this.container.addChild(graphic)
                }

                if (annotation.stale) {
                    graphic.clear()

                    const drawn_path = annotation.path.clone(true)

                    // | a | c | tx|
                    // | b | d | ty|
                    // | 0 | 0 | 1 |
                    // Matrix(a, b, c, d, tx, ty)
                    
                    drawn_path.transform(new PIXI.Matrix(this.resolution, 0, 0, this.resolution, 0, 0))

                    graphic.path(drawn_path)
                    graphic.stroke({ color: 0xFFFFFF, width: 8 })
                    graphic.scale = 1 / this.resolution

                    this.graphics[id] = graphic
                }

                graphic.x = world_origin_screen[0]
                graphic.y = world_origin_screen[1]
                graphic.scale = 1 / this.resolution *  this.worldMap._derived_zoom
                graphic.visible = true
            }
        } else {
            for (const [_, graphic] of Object.entries(this.graphics)) {
                graphic.visible = false
            }
        }
    }
}