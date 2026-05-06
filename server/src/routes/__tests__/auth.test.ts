import express from 'express';
import request from 'supertest';
import { authRouter } from '../auth';
import { _resetStore, login } from '../../services/auth-service';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

beforeEach(() => {
  _resetStore();
});

describe('POST /api/auth/login', () => {
  it('should login a registered user and return token + user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', isAnonymous: false });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.displayName).toBe('alice');
    expect(res.body.user.role).toBe('participant');
    expect(res.body.user.isAnonymous).toBe(false);
  });

  it('should login an anonymous user with a display name', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Guest123', isAnonymous: true });

    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('Guest123');
    expect(res.body.user.isAnonymous).toBe(true);
    expect(res.body.user.role).toBe('participant');
  });

  it('should return 400 when username is empty', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '', isAnonymous: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('USERNAME_REQUIRED');
  });

  it('should return 400 when username is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ isAnonymous: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('USERNAME_REQUIRED');
  });

  it('should return 400 when anonymous display name is empty', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '   ', isAnonymous: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DISPLAY_NAME_REQUIRED');
  });
});

describe('GET /api/auth/validate', () => {
  it('should validate a valid token and return user', async () => {
    const { token } = login('bob', false);

    const res = await request(app)
      .get('/api/auth/validate')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('bob');
    expect(res.body.user.role).toBe('participant');
  });

  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/auth/validate');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REQUIRED');
  });

  it('should return 401 when Authorization header has wrong format', async () => {
    const res = await request(app)
      .get('/api/auth/validate')
      .set('Authorization', 'InvalidFormat token123');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REQUIRED');
  });

  it('should return 401 for an invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/validate')
      .set('Authorization', 'Bearer invalid-token-value');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });
});

describe('POST /api/auth/logout', () => {
  it('should logout and invalidate the token', async () => {
    const { token } = login('charlie', false);

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Token should no longer be valid
    const validateRes = await request(app)
      .get('/api/auth/validate')
      .set('Authorization', `Bearer ${token}`);

    expect(validateRes.status).toBe(401);
  });

  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REQUIRED');
  });

  it('should return 401 when Authorization header has wrong format', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REQUIRED');
  });
});
