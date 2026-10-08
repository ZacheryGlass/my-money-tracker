import '@testing-library/jest-dom';

// jsdom does not implement ResizeObserver (used by SummaryStats and Recharts).
if (!global.ResizeObserver) {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement matchMedia (used by useMediaQuery).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// The crypto registry facts the app loads once from GET /api/crypto/meta. The
// fixture is the backend's own output (backend/tests/cryptoMetaFixture.test.js
// fails when they diverge).
import { setCryptoMeta } from '../features/crypto/meta';
import cryptoMetaFixture from './cryptoMeta.fixture.json';

setCryptoMeta(cryptoMetaFixture);
