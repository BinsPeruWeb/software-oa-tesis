import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { AppModule } from './app.module';

function required(name: string, minimum = 24) {
  const value = process.env[name] ?? '';
  if (value.length < minimum) throw new Error(`${name} no está configurado de forma segura`);
}

async function bootstrap() {
  required('JWT_SECRET', 32); required('SERVICE_TOKEN', 24);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: {
    directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] },
  } }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use('/api', (_req: Request, response: Response, next: NextFunction) => { response.setHeader('cache-control', 'no-store'); next(); });
  app.use('/api', (request: Request, response: Response, next: NextFunction) => {
    const gated = process.env.DEPLOYMENT_ENV === 'production' && process.env.CLINICAL_PRODUCTION_APPROVED !== 'true';
    const clinicalWrite = request.method !== 'GET' && /^\/(patients|episodes|observations|predictions|reports)/.test(request.path);
    if (gated && clinicalWrite) return response.status(503).json({ message: 'Producción clínica bloqueada: puerta institucional pendiente' });
    next();
  });

  const loginWindows = new Map<string, { count: number; reset: number }>();
  app.use('/api/auth/login', (request: Request, response: Response, next: NextFunction) => {
    const key = request.ip ?? 'unknown'; const now = Date.now();
    const item = loginWindows.get(key);
    const window = !item || item.reset < now ? { count: 0, reset: now + 60_000 } : item;
    window.count += 1; loginWindows.set(key, window);
    if (window.count > 10) return response.status(429).json({ message: 'Demasiados intentos; espere un minuto' });
    next();
  });

  const publicPath = path.resolve(process.cwd(), 'public');
  app.useStaticAssets(publicPath, { index: false, etag: true, maxAge: '1h' });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' && !request.path.startsWith('/api/')) {
      response.setHeader('cache-control', 'no-store');
      return response.sendFile(path.join(publicPath, 'index.html'));
    }
    next();
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
