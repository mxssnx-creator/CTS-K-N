import { readFileSync } from "node:fs"
import { resolve } from "node:path"
const route = readFileSync(resolve(process.cwd(), "app/api/settings/connections/[id]/settings/route.ts"), "utf8")
describe("a connection-settings save never resets an operator channel volume factor", () => {
  test.each([["live", "live_volume_factor"], ["preset", "preset_volume_factor"], ["signal", "signal_volume_factor"]])(
    "%s: the request's own value, then the connection's current value, precede the dialog base alias", (ch, field) => {
      const i = route.indexOf(`const requested${ch[0].toUpperCase()}${ch.slice(1)} = settings.volume_factor_${ch} ?? settings.${field}`)
      expect(i).toBeGreaterThan(0)
      const block = route.slice(i, i + 400)
      const req = block.indexOf(`requested${ch[0].toUpperCase()}${ch.slice(1)} ??`)
      const conn = block.indexOf(`connection.${field} ??`)
      const alias = block.indexOf(`merged.baseVolumeFactor`)
      expect(req).toBeGreaterThan(0); expect(conn).toBeGreaterThan(req); expect(alias).toBeGreaterThan(conn)
    })
})
