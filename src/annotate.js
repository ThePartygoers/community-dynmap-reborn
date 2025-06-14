import { Handle } from "./handle.js"

function isBoxOnscreen(box, screenWidth, screenHeight) {

    if (box[1][0] < 0) return false
    if (box[0][0] > screenWidth) return false
    if (box[1][1] < 0) return false
    if (box[0][1] > screenHeight) return false

    return true
}

function randomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

    let result = ""

    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }

    return result
}

export class Annotation {
    name = "Annotation"
    bounds = undefined
    handles = []

    tick() {}

    clearHandles() {
        this.handles.forEach(handle => handle.destroy())
        this.handles = []
    }
}

export class ContainerAnnotation extends Annotation {
    
    static FIDELITY = 32

    name = "Container"

    container = undefined
    world_pos = [0, 0]

    createHandles() {
        this.clearHandles()

        const that = this

        function updateHandles() {
            that.handles[0].world_pos = that.world_pos
        }

        this.handles = [
            new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
                this.world_pos = [x, z]
                this.bounds = [ this.world_pos, this.world_pos ]
                updateHandles()
            }),
        ]

        updateHandles()
    }

    constructor(worldPos) {
        super()
        this.world_pos = worldPos
        this.container = new PIXI.Container()

        this.bounds = [
            this.world_pos,
            this.world_pos
        ]
    }
}

export class TextAnnotation extends ContainerAnnotation {
    constructor(worldPos, text) {
        super(worldPos)

        this.label = new PIXI.Text({
            text: text,
            style: {
                fontFamily: 'Arial',
                fontSize: 50,
                fill: 0xFFFFFF,
            }
        })

        this.container.addChild(this.label)
    }
}

export class PathAnnotation extends Annotation {

    name = "Path"

    path = undefined

    stale = false
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
            new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [x, z], 
                    this.bounds[1]
                )
                updateHandles()
            }),
            new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [this.bounds[0][0], z], 
                    [x, this.bounds[1][1]]
                )
                updateHandles()
            }),
            new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
                this.updatePath(
                    [x, this.bounds[0][1]], 
                    [this.bounds[1][0], z]
                )
                updateHandles()
            }),
            new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
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

    points = []

    constructor(points) {
        super()
        this.points = points
        this.updatePath(points)
    }

    createHandles() {
        this.clearHandles()

        const that = this

        function updateHandles(handle) {
            that.handles.forEach((handle, index) => {
                handle.world_pos = that.points[index]
            })
        }

        this.handles = this.points.map((point, index) => new Handle(this.world_map, [ 0, 0 ], ([x, z]) => {
            this.points[index] = [x, z]
            this.updatePath(
                this.points
            )
            updateHandles()
        }))

        updateHandles()
    }

    updatePath(points) {
        if (points.length < 3) return

        this.path = new PIXI.GraphicsPath()

        this.path.moveTo(points[0][0], points[0][1])

        for (let i = 1; i < points.length; i++) {
            const [x, y] = points[i]

            this.path.lineTo(x, y)
        }

        this.path.closePath()

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

export class Annotations {
    static RESOLUTION = 16

    resolution = Annotations.RESOLUTION

    annotations = {}
    world_bounds = null
    
    derived_width = 0
    derived_height = 0
    
    graphics = {}
    containters = {}

    selected = new Set()

    container = new PIXI.Container()

    constructor(world_map) {
        this.world_map = world_map
    }

    #expandBounds([x, y]) {
        if (!Number.isFinite(x)) return
        if (!Number.isFinite(y)) return

        if (this.world_bounds == null) this.world_bounds = [[Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE]]

        this.world_bounds[0][0] = Math.min(this.world_bounds[0][0], x)
        this.world_bounds[0][1] = Math.min(this.world_bounds[0][1], y)
        this.world_bounds[1][0] = Math.max(this.world_bounds[1][0], x)
        this.world_bounds[1][1] = Math.max(this.world_bounds[1][1], y)

        this.derived_width = this.world_bounds[1][0] - this.world_bounds[0][0]
        this.derived_height = this.world_bounds[1][1] - this.world_bounds[0][1]
    }

    addAnnotation(annotation) {
        const id = randomString(32)

        this.#expandBounds(annotation.bounds[0])
        this.#expandBounds(annotation.bounds[1])

        this.annotations[id] = annotation

        annotation.world_map = this.world_map
        annotation.id = id
        
        if (annotation instanceof ContainerAnnotation) {
            this.container.addChild(annotation.container)
            this.containters[id] = annotation.container
        }

        return id
    }

    removeAnnotation(id) {
        this.annotations[id].clearHandles()

        this.selected.delete(this.annotations[id])
        delete this.annotations[id]
        this.container.removeChild(this.containters[id])
    }

    getAnnotations() {
        return Object.values(this.annotations)
    }

    addSelected(annotation) {
        this.selected.add(annotation)
        annotation.createHandles()
    }

    getSelected() {
        return this.selected
    }

    clearSelected() {
        this.selected.forEach(annotation => {
            annotation.clearHandles()
        })

        this.selected.clear()
    }

    tick(screenWidth, screenHeight) {
        if (this.world_bounds == null) return

        const screenBounds = this.world_bounds.map(pos => this.world_map.toScreenSpace(pos))

        if (isBoxOnscreen(screenBounds, screenWidth, screenHeight) || true) {
            const world_origin_screen = this.world_map.toScreenSpace([0, 0]) // TODO: cascade this down?

            for (const [id, annotation] of Object.entries(this.annotations)) {
                if (!isBoxOnscreen(
                    annotation.bounds.map(pos => this.world_map.toScreenSpace(pos)),
                    screenWidth,
                    screenHeight
                )) continue

                if (annotation instanceof PathAnnotation) {
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
                    graphic.scale = 1 / this.resolution *  this.world_map._derived_zoom
                    graphic.visible = true
                } else if (annotation instanceof ContainerAnnotation) {
                    const [x, y] = this.world_map.toScreenSpace(annotation.world_pos)

                    annotation.container.x = x
                    annotation.container.y = y
                    annotation.container.visible = true

                    annotation.container.scale = this.world_map._derived_zoom / annotation.constructor.FIDELITY

                    annotation.tick()
                }
            }
        } else {
            for (const [_, graphic] of Object.entries(this.graphics)) {
                graphic.visible = false
            }

            for (const [_, container] of Object.entries(this.containters)) {
                container.visible = false
            }
        }
    }
}