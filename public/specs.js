'use strict';

// Platform specs from the RUX Paid Social Creative Playbook, and how an asset
// of a given pixel size fits each placement. Runs in the browser
// (window.RuxSpecs) and in Node.
(function (root) {
  const PLACEMENTS = [
    { id: 'reels', name: 'Reels', aspect: '9:16', ar: 9 / 16, w: 1080, h: 1920 },
    { id: 'stories', name: 'Stories', aspect: '9:16', ar: 9 / 16, w: 1080, h: 1920 },
    { id: 'feed45', name: 'Feed 4:5', aspect: '4:5', ar: 4 / 5, w: 1080, h: 1350 },
    { id: 'feed11', name: 'Feed 1:1', aspect: '1:1', ar: 1, w: 1080, h: 1080 },
    { id: 'carousel', name: 'Carousel', aspect: '1:1', ar: 1, w: 1080, h: 1080 },
    { id: 'google-landscape', name: 'Google landscape', aspect: '1.91:1', ar: 1.91, w: 1200, h: 628 },
    { id: 'google-square', name: 'Google square', aspect: '1:1', ar: 1, w: 1200, h: 1200 },
    { id: 'google-portrait', name: 'Google portrait', aspect: '4:5', ar: 4 / 5, w: 960, h: 1200 },
  ];

  // 'ready': the placement's shape (within 2%) and at least its minimum size.
  // 'crop': a centered crop to that shape would still meet the minimum (the
  //   playbook asks for deliberate crops rather than relying on auto-cropping).
  // 'small': too few pixels either way.
  function check(width, height, p) {
    if (!width || !height) return null;
    const ratio = width / height;
    if (Math.abs(ratio - p.ar) / p.ar < 0.02) {
      return width >= p.w && height >= p.h
        ? { status: 'ready', detail: `${width}×${height}` }
        : { status: 'small', detail: `Needs ${p.w}×${p.h}, has ${width}×${height}` };
    }
    const cw = ratio > p.ar ? Math.round(height * p.ar) : width;
    const ch = ratio > p.ar ? height : Math.round(width / p.ar);
    return cw >= p.w && ch >= p.h
      ? { status: 'crop', detail: `Crop to ${cw}×${ch}` }
      : { status: 'small', detail: `A ${p.aspect} crop would be ${cw}×${ch}; needs ${p.w}×${p.h}` };
  }

  // Placements an asset can be used for, as it is or with a deliberate crop.
  function usableFor(width, height) {
    return PLACEMENTS.filter((p) => ['ready', 'crop'].includes(check(width, height, p)?.status)).map((p) => p.name);
  }

  const isVertical = (width, height) => Boolean(width && height) && Math.abs(width / height - 9 / 16) / (9 / 16) < 0.02;

  const api = { PLACEMENTS, check, usableFor, isVertical };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RuxSpecs = api;
})(this);
