/** Bounded `<loc>` extraction from sitemap XML — locations only, nothing else is read. */
export function parseSitemapLocations(xml: string): readonly string[] {
  const locations: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const location = match[1];
    if (location !== undefined && location !== '') locations.push(location);
  }
  return locations;
}
