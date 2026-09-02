import React from 'react';

const SHOW_THRESHOLD = 96;

export function ScrollToBottomButton({ scrollRef, resetKey = '' }) {
  const [visible, setVisible] = React.useState(false);
  const frameRef = React.useRef(null);
  const followLatestRef = React.useRef(true);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;

    followLatestRef.current = true;
    const update = () => {
      frameRef.current = null;
      setVisible(element.scrollHeight - element.scrollTop - element.clientHeight > SHOW_THRESHOLD);
    };
    const scheduleUpdate = () => {
      if (!frameRef.current) frameRef.current = requestAnimationFrame(update);
    };
    const handleScroll = () => {
      followLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= SHOW_THRESHOLD;
      scheduleUpdate();
    };
    const handleContentChange = () => {
      if (followLatestRef.current) element.scrollTop = element.scrollHeight;
      scheduleUpdate();
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    const mutationObserver = new MutationObserver(handleContentChange);
    mutationObserver.observe(element, { childList: true, characterData: true, subtree: true });
    const resizeObserver = new ResizeObserver(handleContentChange);
    resizeObserver.observe(element);
    element.scrollTop = element.scrollHeight;
    scheduleUpdate();

    return () => {
      element.removeEventListener('scroll', handleScroll);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [resetKey, scrollRef]);

  function scrollToLatest() {
    followLatestRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }

  return (
    <button type="button" className={`scroll-to-bottom-button${visible ? ' is-visible' : ''}`} onClick={scrollToLatest} aria-label="Scroll to latest message" aria-hidden={!visible} tabIndex={visible ? 0 : -1}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M6 13l6 6 6-6" /></svg>
    </button>
  );
}
