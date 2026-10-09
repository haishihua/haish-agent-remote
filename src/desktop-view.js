// Fit the entire measured desktop at 1×; zoom enlarges that rectangle without
// distortion. The scroll viewport then exposes all cropped regions by panning.
export function desktopViewSize(viewportWidth, viewportHeight, width, height, zoom) {
  const ratio = width > 0 && height > 0 ? width / height : 16 / 10;
  const fitWidth = Math.min(viewportWidth, viewportHeight * ratio);
  return { width: fitWidth * zoom, height: fitWidth / ratio * zoom };
}
