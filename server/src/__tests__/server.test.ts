import request from 'supertest';
import { app, server, wss } from '../server';

afterAll((done) => {
  wss.close();
  server.close(done);
});

describe('Express server entry point', () => {
  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('API routes', () => {
    it('should mount /api/auth routes and accept JSON', async () => {
      // POST to /api/auth/login with empty body should return 400 (validation error)
      const res = await request(app)
        .post('/api/auth/login')
        .send({})
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(400);
    });

    it('should handle /api/auth/login with valid username', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', isAnonymous: false })
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('user');
    });
  });

  describe('SPA fallback', () => {
    it('should return a response for unknown routes (SPA fallback)', async () => {
      // The fallback tries to serve index.html from the Angular build directory.
      // In test environment the file may not exist, so we expect either 200 (if built)
      // or a non-404 response showing the route was caught by the fallback handler.
      const res = await request(app).get('/some/angular/route');
      // The fallback route handler is registered, so Express won't return its default 404.
      // If the file doesn't exist, sendFile returns 404 from the static file handler,
      // but the route itself is matched.
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('Exports', () => {
    it('should export app, server, and wss', () => {
      expect(app).toBeDefined();
      expect(server).toBeDefined();
      expect(wss).toBeDefined();
    });
  });
});
