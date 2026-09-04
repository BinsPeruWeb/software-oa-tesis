import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminController } from './admin';
import { AdminGuard, AuthController, AuthService, ClinicianGuard, CsrfGuard, SessionGuard } from './auth';
import { ClinicalController } from './clinical';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';
import { PeruDevsService } from './identity';
import { PatientsController, PatientsService } from './patients';
import { InferenceWorker, StudiesController } from './studies';

@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET, signOptions: { issuer: 'oa-web-api', audience: 'oa-pwa' } })],
  controllers: [AuthController, PatientsController, StudiesController, ClinicalController, AdminController],
  providers: [
    DatabaseService, CryptoService, AssetService, AuditService,
    AuthService, SessionGuard, CsrfGuard, AdminGuard, ClinicianGuard,
    PatientsService, PeruDevsService, InferenceWorker,
  ],
})
export class AppModule {}
