import { getStore } from '@netlify/blobs';
import { createHandler } from '../../src/netlify.js';

export default createHandler({
  blobs: () => getStore({ name: 'playroom', consistency: 'strong' }),
  env: {
    ADMIN_PASSWORD: Netlify.env.get('ADMIN_PASSWORD'),
    DURATION_MINUTES: Netlify.env.get('DURATION_MINUTES'),
    TIME_ZONE: Netlify.env.get('TIME_ZONE'),
  },
});

export const config = { path: '/api/*' };
