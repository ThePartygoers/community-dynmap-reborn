import { Handle } from "./handle.js"

function isBoxOnscreen(box, screenWidth, screenHeight) {

    if (box[1][0] < 0) return false
    if (box[0][0] > screenWidth) return false
    if (box[1][1] < 0) return false
    if (box[0][1] > screenHeight) return false

    return true
}
export class PathAnnotation {
    name = "Path"

    path = undefined
    bounds = undefined

    stale = false

    handles = []
}

export class RectangleAnnotation extends PathAnnotation {

    static MIN_SIZE = 2

    name = "Rectangle"

    constructor([x1, y1], [x2, y2]) {
        super()
        this.updatePath([x1, y1], [x2, y2])
    }

    createHandles() {
        this.handles.forEach(handle => handle.cleanup)

        const that = this

        function updateHandles() {
            const [x1, z1] = that.bounds[0]
            const [x2, z2] = that.bounds[1]

            that.handles[0].world_pos = [x1, z1]
            that.handles[1].world_pos = [x2, z1]
            that.handles[2].world_pos = [x1, z2]
            that.handles[3].world_pos = [x2, z2]


            that.handles[0].bounds = [
                [null, null],
                [x2 - RectangleAnnotation.MIN_SIZE, z2 - RectangleAnnotation.MIN_SIZE]
            ]

            that.handles[1].bounds = [
                [x1 + RectangleAnnotation.MIN_SIZE, null],
                [null, z2 - RectangleAnnotation.MIN_SIZE]
            ]

            that.handles[2].bounds = [
                [null, z1 + RectangleAnnotation.MIN_SIZE],
                [x2 - RectangleAnnotation.MIN_SIZE, null]
            ]

            that.handles[3].bounds = [
                [x1 + RectangleAnnotation.MIN_SIZE, z1 + RectangleAnnotation.MIN_SIZE],
                [null, null]
            ]
        }

        this.handles = [
            new Handle(this.worldMap, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [x, z], 
                    this.bounds[1]
                )
                updateHandles()
            }),
            new Handle(this.worldMap, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [this.bounds[0][0], z], 
                    [x, this.bounds[1][1]]
                )
                updateHandles()
            }),
            new Handle(this.worldMap, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [x, this.bounds[0][1]], 
                    [this.bounds[1][0], z]
                )
                updateHandles()
            }),
            new Handle(this.worldMap, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    this.bounds[0],
                    [x, z]
                )
                updateHandles()
            }),
        ]

        updateHandles()
    }

    updatePath([x1, z1], [x2, z2]) {

        this.path = new PIXI.GraphicsPath()
            .moveTo(x1, z1)
            .lineTo(x2, z1)
            .lineTo(x2, z2)
            .lineTo(x1, z2)
            .closePath()

        this.bounds = [
            [
                this.path.shapePath.bounds.left,
                this.path.shapePath.bounds.top
            ],
            [
                this.path.shapePath.bounds.right,
                this.path.shapePath.bounds.bottom
            ]
        ]

        this.stale = true
    }
}

export class PolygonAnnotation extends PathAnnotation {

    name = "Polygon"

    path = undefined
    bounds = undefined

    stale = false

    constructor([x1, y1], [x2, y2]) {
        super()
        this.updatePath([x1, y1], [x2, y2])
    }

    #expandBounds([x, y]) {
        if (this.bounds == null) this.bounds = [[9e9, 9e9], [-9e9, -9e9]]

        this.bounds[0][0] = Math.min(this.bounds[0][0], x)
        this.bounds[0][1] = Math.min(this.bounds[0][1], y)
        this.bounds[1][0] = Math.max(this.bounds[1][0], x)
        this.bounds[1][1] = Math.max(this.bounds[1][1], y)
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

        console.log(this.bounds)

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
        this.world_bounds[0][1] = Math.min(this.world_bounds[0][1], y)
        this.world_bounds[1][0] = Math.max(this.world_bounds[1][0], x)
        this.world_bounds[1][1] = Math.max(this.world_bounds[1][1], y)

        this.derived_width = this.world_bounds[1][0] - this.world_bounds[0][0]
        this.derived_height = this.world_bounds[1][1] - this.world_bounds[0][1]
    }

    addAnnotation(annotation) {
        const id = crypto.randomUUID()

        this.#expandBounds(annotation.bounds[0])
        this.#expandBounds(annotation.bounds[1])

        this.annotations[id] = annotation

        annotation.worldMap = this.worldMap

        return id
    }

    tick(screenWidth, screenHeight) {
        if (this.world_bounds == null) return

        const screenBounds = this.world_bounds.map(pos => this.worldMap.toScreenSpace(pos))

        if (isBoxOnscreen(screenBounds, screenWidth, screenHeight)) {
            const world_origin_screen = this.worldMap.toScreenSpace([0, 0]) // TODO: cascade this down?

            for (const [id, annotation] of Object.entries(this.annotations)) {

                // if (!isBoxOnscreen(annotation.bounds.map(pos => this.worldMap.toScreenSpace(pos)), screenWidth, screenHeight)) {
                //     continue
                // }

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