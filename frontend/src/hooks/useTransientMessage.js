import { useCallback, useEffect, useRef, useState } from 'react';

// Message state that clears itself after `duration` ms. The timeout resets on
// each show() and is cleaned up on unmount, so navigating away while a
// message is visible cannot set state on an unmounted component.
export default function useTransientMessage(duration = 3000) {
  const [message, setMessage] = useState('');
  const timeoutRef = useRef();

  const show = useCallback((text) => {
    clearTimeout(timeoutRef.current);
    setMessage(text);
    timeoutRef.current = setTimeout(() => setMessage(''), duration);
  }, [duration]);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  return [message, show];
}
