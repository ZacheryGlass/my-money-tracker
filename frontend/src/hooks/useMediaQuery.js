import { useState, useEffect } from 'react';

/**
 * Custom hook to handle media queries for responsive design
 * @param {string} query - Media query string (e.g., '(min-width: 768px)')
 * @returns {boolean} - Whether the media query matches
 */
export const useMediaQuery = (query) => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    // Check if window is defined (for SSR compatibility)
    if (typeof window === 'undefined') {
      return;
    }

    const media = window.matchMedia(query);
    
    // Set initial value
    setMatches(media.matches);

    // Create event listener
    const listener = (event) => {
      setMatches(event.matches);
    };

    // Use addEventListener if available, otherwise use deprecated addListener
    if (media.addEventListener) {
      media.addEventListener('change', listener);
    } else {
      media.addListener(listener);
    }

    // Cleanup
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', listener);
      } else {
        media.removeListener(listener);
      }
    };
  }, [query]);

  return matches;
};

/**
 * Convenience hook for mobile detection
 * @returns {boolean} - Whether the screen is mobile-sized
 */
export const useIsMobile = () => {
  return useMediaQuery('(max-width: 767px)');
};

/**
 * Convenience hook for tablet detection
 * @returns {boolean} - Whether the screen is tablet-sized
 */
export const useIsTablet = () => {
  return useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
};

/**
 * Convenience hook for desktop detection
 * @returns {boolean} - Whether the screen is desktop-sized
 */
export const useIsDesktop = () => {
  return useMediaQuery('(min-width: 1024px)');
};
