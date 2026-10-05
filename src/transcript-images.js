const RESOLVED_TIMELINES = new WeakMap();

/** Resolve authenticated mobile image previews in inline correction nodes only. */
export function resolveTranscriptImages(timeline, resolve) {
  if (!Array.isArray(timeline)) return timeline;
  let changed = false;
  const previous = RESOLVED_TIMELINES.get(timeline);
  const next = timeline.map((item, index) => {
    if (item?.kind !== 'user_input' || !item.images?.length) return item;
    const images = item.images.map(resolve).filter(Boolean);
    if (images.length === item.images.length && images.every((image, index) => image === item.images[index])) return item;
    changed = true;
    const cached = previous?.[index];
    if (cached?.images?.length === images.length && images.every((image, i) => image === cached.images[i])) return cached;
    return { ...item, images };
  });
  if (!changed) return timeline;
  if (previous?.length === next.length && next.every((item, index) => item === previous[index])) return previous;
  RESOLVED_TIMELINES.set(timeline, next);
  return next;
}

export function transcriptImageRefs(row) {
  return (row.traceTimeline || []).flatMap((item) => item?.kind === 'user_input' ? item.images || [] : []);
}
