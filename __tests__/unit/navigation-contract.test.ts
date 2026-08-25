import fs from "node:fs"
import path from "node:path"

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
}

function literalRoutes(fileSource: string): string[] {
  return Array.from(fileSource.matchAll(/\bhref:\s*"([^"]+)"/g), (match) => match[1])
    .filter((href) => href.startsWith("/"))
}

function pagePath(href: string): string {
  return href === "/"
    ? path.join(process.cwd(), "app", "page.tsx")
    : path.join(process.cwd(), "app", href.slice(1), "page.tsx")
}

describe("site navigation contract", () => {
  test("publishes explicit favicon metadata backed by real public assets", () => {
    const layoutSource = source("app/layout.tsx")
    const iconPaths = [
      "/icon.svg",
      "/icon-light-32x32.png",
      "/icon-dark-32x32.png",
      "/apple-icon.png",
    ]

    expect(layoutSource).toContain("icons: {")
    for (const iconPath of iconPaths) {
      expect(layoutSource).toContain(`url: "${iconPath}"`)
      expect(fs.existsSync(path.join(process.cwd(), "public", iconPath.slice(1)))).toBe(true)
    }
  })

  test.each([
    "components/app-sidebar.tsx",
    "components/dashboard/navigation-menu.tsx",
  ])("%s uses unique links that resolve to real pages", (relativePath) => {
    const fileSource = source(relativePath)
    const routes = literalRoutes(fileSource)

    expect(routes.length).toBeGreaterThan(0)
    expect(new Set(routes).size).toBe(routes.length)
    for (const route of routes) {
      expect({ route, exists: fs.existsSync(pagePath(route)) }).toEqual({
        route,
        exists: true,
      })
    }
  })

  test.each([
    "components/app-sidebar.tsx",
    "components/dashboard/navigation-menu.tsx",
  ])("%s keeps parent navigation active on nested pages", (relativePath) => {
    expect(source(relativePath)).toContain("currentPath.startsWith(`${item.href}/`)")
  })
})
