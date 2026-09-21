// The downtown city data compiled INTO the page (for the single-file offline build, `EMBED_CITY=1 npm run build`, made by
// `npm run package`). Used instead of fetching /city/ so the file works from disk with no server and no internet.
const files = import.meta.glob('../data/city_dt/**/*.json', { eager: true, import: 'default' });

export function embeddedCity() {
  const city = files['../data/city_dt/city.json'];
  const tiles = {};
  for (const [path, data] of Object.entries(files)) {
    const m = /tiles\/(-?\d+_-?\d+)\.json$/.exec(path);
    if (m) tiles[m[1]] = data;
  }
  return { city, source: async (tx, ty) => tiles[`${tx}_${ty}`] ?? null };
}
