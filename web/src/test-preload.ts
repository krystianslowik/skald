/**
 * Loads the Dashboard's lazy chunks up front. The first test in a file that opens a sheet otherwise pays for
 * transforming the chunk inside its findBy* window, which on a loaded machine is longer than the wait itself.
 * Use as `beforeAll(preloadLazyChunks)`.
 */
export async function preloadLazyChunks() {
  await Promise.all([
    import("./components/ProfileSheet"),
    import("./components/SettingsSheet"),
    import("./components/map/MapView"),
    import("./components/map/MapPreview"),
    import("./components/admin/AdminSheets"),
  ]);
}
