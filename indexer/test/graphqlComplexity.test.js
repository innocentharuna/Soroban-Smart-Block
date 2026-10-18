import request from 'supertest';
import express from 'express';

// Uses the real `graphql` parser. The middleware loads it with a dynamic
// import(), which jest.unstable_mockModule does not intercept reliably, so
// the tests drive it with real queries instead of a mocked parse().
const { graphqlComplexityLimiter } = await import(
  '../src/rateLimit/graphqlComplexity.js'
);

function createTestApp(rateContext) {
  const app = express();
  app.use(express.json());
  if (rateContext) {
    app.use((req, res, next) => {
      req.rateContext = rateContext;
      next();
    });
  }
  app.use('/graphql', graphqlComplexityLimiter);
  app.post('/graphql', (req, res) => res.json({ ok: true }));
  app.get('/api/other', (req, res) => res.json({ ok: true }));
  return app;
}

function post(app, query) {
  return request(app).post('/graphql').send({ query });
}

describe('graphqlComplexity middleware (issue #763)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('Allow path: query under complexity budget', () => {
    it('allows simple query that is under the budget', async () => {
      const res = await post(app, '{ __typename }');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('sets X-GraphQL-Cost header for allowed queries', async () => {
      const res = await post(app, '{ __typename }');

      expect(res.headers['x-graphql-cost']).toBeDefined();
      expect(res.headers['x-graphql-cost-remaining']).toBeDefined();
    });

    it('computes correct cost-remaining', async () => {
      const res = await post(app, '{ __typename }');

      const cost = parseInt(res.headers['x-graphql-cost']);
      const remaining = parseInt(res.headers['x-graphql-cost-remaining']);

      // For unauthenticated (default), budget is 100
      expect(remaining).toBe(100 - cost);
      expect(remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Deny path: query exceeds complexity budget', () => {
    // 11 list-style fields (name ends in "s") => 11 * 10 = 110 > 100
    const overBudget = `{ ${Array.from({ length: 11 }, (_, i) => `item${i}s`).join(' ')} }`;

    it('rejects query that exceeds budget', async () => {
      const res = await post(app, overBudget);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({ error: 'Query complexity exceeded' })
      );
    });

    it('includes cost and limit in error response', async () => {
      const res = await post(app, overBudget);

      expect(res.status).toBe(400);
      expect(res.body.cost).toBe(110);
      expect(res.body.limit).toBe(100);
    });
  });

  describe('List field multiplier', () => {
    it('applies 10x multiplier to fields ending in "s"', async () => {
      const res = await post(app, '{ users }');

      expect(res.status).toBe(200);
      expect(parseInt(res.headers['x-graphql-cost'])).toBe(10);
    });

    it('applies 10x multiplier to known list field names', async () => {
      for (const field of ['edges', 'nodes', 'items', 'results', 'data']) {
        const res = await post(app, `{ ${field} }`);
        expect(parseInt(res.headers['x-graphql-cost'])).toBe(10);
      }
    });

    it('does not apply multiplier to singular field names', async () => {
      const res = await post(app, '{ user }');

      expect(parseInt(res.headers['x-graphql-cost'])).toBe(1);
    });
  });

  describe('Tier-based budget', () => {
    it('applies tier budget from rateContext', async () => {
      const proApp = createTestApp({ tier: 'pro' });

      const res = await post(proApp, '{ data }');

      expect(res.status).toBe(200);
      // Pro tier budget is 2000, cost is 10
      expect(parseInt(res.headers['x-graphql-cost-remaining'])).toBe(1990);
    });

    it('allows a query on a higher tier that would exceed the default budget', async () => {
      const freeApp = createTestApp({ tier: 'free' });
      const query = `{ ${Array.from({ length: 11 }, (_, i) => `item${i}s`).join(' ')} }`;

      const res = await post(freeApp, query);

      expect(res.status).toBe(200);
      expect(parseInt(res.headers['x-graphql-cost'])).toBe(110);
    });
  });

  describe('Edge cases', () => {
    it('skips middleware for non-GraphQL paths', async () => {
      const res = await request(app).get('/api/other').send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('passes through when there is no query in request', async () => {
      const res = await request(app).post('/graphql').send({});

      expect(res.status).toBe(200);
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('passes through on parse error', async () => {
      const res = await post(app, '{ invalid syntax');

      expect(res.status).toBe(200);
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('handles nested selection sets correctly', async () => {
      const res = await post(app, '{ users { id name } }');

      expect(res.status).toBe(200);
      expect(parseInt(res.headers['x-graphql-cost'])).toBe(12); // 10 + 1 + 1
    });

    it('handles fragment spreads with minimal cost', async () => {
      const res = await post(
        app,
        '{ user ...UserFragment } fragment UserFragment on Query { id }'
      );

      expect(res.status).toBe(200);
      // user (1) + spread (1) + fragment definition body: id (1)
      expect(parseInt(res.headers['x-graphql-cost'])).toBe(3);
    });
  });
});
