// One top bar for the public pages (acard-site-bar-unify): build.ts copies the landing's <header class="nav"> from
// assets/_site/index.html into every page that carries SITE_NAV_MARKER, so the bar is written once. The landing's
// in-page links (#features) point back at the landing (/#features) and the page's own link gets aria-current.
export const SITE_NAV_MARKER = "<!--site-nav-->";

export function landingHeader(landing: string): string {
  const header = /<header class="nav">[\s\S]*?<\/header>/.exec(landing)?.[0];
  if (!header) throw new Error("assets/_site/index.html has no <header class=\"nav\">");
  return header;
}

export function withSiteNav(page: string, landing: string, path: string): string {
  if (!page.includes(SITE_NAV_MARKER)) throw new Error("page for " + path + " has no " + SITE_NAV_MARKER);
  const header = landingHeader(landing)
    .replace(/href="#/g, 'href="/#')
    .replace(new RegExp('<a href="' + path + '"', "g"), '<a href="' + path + '" aria-current="page"');
  return page.replace(SITE_NAV_MARKER, () => header);
}
