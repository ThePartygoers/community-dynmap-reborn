function onScreen(screen_pos, screenWidth, screenHeight) {
    if (screen_pos[0] < 0) return false
    if (screen_pos[1] < 0) return false
    if (screen_pos[0] > screenWidth) return false
    if (screen_pos[1] > screenHeight) return false

    return true
}

export class Handle {
    static RESOLUTION = 16
    static HANDLE_SIZE = 10

    resolution = Handle.RESOLUTION

    world_pos = [0, 0]

    constructor(worldMap, world_pos, update, bounds) {
        this.worldMap = worldMap

        this.world_pos = world_pos || [0, 0]

        this.root = new PIXI.Container()
        this.root.name = "Handle"

        this.root.zIndex = 10

        this.bounds = bounds

        this.handle = new PIXI.Graphics()
            .moveTo(Handle.HANDLE_SIZE, 0)
            .lineTo(0, Handle.HANDLE_SIZE)
            .lineTo(-Handle.HANDLE_SIZE, 0)
            .lineTo(0, -Handle.HANDLE_SIZE)
            .closePath()
            .fill(0x000000)
            .moveTo(Handle.HANDLE_SIZE - 4, 0)
            .lineTo(0, Handle.HANDLE_SIZE - 4)
            .lineTo(-Handle.HANDLE_SIZE + 4, 0)
            .lineTo(0, -Handle.HANDLE_SIZE + 4)
            .closePath()
            .fill(0xFFFFFF)
        
        this.root.addChild(this.handle)

        worldMap.app.stage.addChild(this.root)
        worldMap.handles.push(this)

        this._update = update
    }

    update([wx, wz]) {

        if (this.bounds) {
            const [min, max] = this.bounds

            if (min[0] != null) wx = Math.max(wx, min[0])
            if (min[1] != null) wz = Math.max(wz, min[1])
            if (max[0] != null) wx = Math.min(wx, max[0])
            if (max[1] != null) wz = Math.min(wz, max[1])
        }

        this._update([wx, wz])

        this.world_pos = [wx, wz]
    }

    tick(screenWidth, screenHeight) {

        const screen_pos = this.worldMap.toScreenSpace(this.world_pos, screenWidth, screenHeight)

        if (!onScreen(screen_pos)) {
            this.root.visible = false
            return
        }

        this.root.visible = true

        this.root.x = screen_pos[0]
        this.root.y = screen_pos[1]

        if (this == this.worldMap.held_handle) {
            this.root.tint = 0xFFFFFF
        } else if (this == this.worldMap.hovered_handle) {
            this.root.tint = 0x888888
        } else {
            this.root.tint = 0xFFFFFF
        }

    }

    destroy() {
        this.root.destroy({ children: true })
        this.worldMap.app.stage.removeChild(this.root)
        this.worldMap.handles.splice(this.worldMap.handles.indexOf(this), 1)
    }
}