export const isNavigationHeading = value => /^(?:目录|本页目录|contents|table\s+of\s+contents)$/i.test(String(value || '').trim());

export function readingOutline(items) {
  return items.flatMap(item => {
    const children = readingOutline(item.children || []);
    return item.slug === '_top' || isNavigationHeading(item.text) ? children : [{ ...item, children }];
  });
}
