/*
  Plataforma OA - esquema completo para Microsoft SQL Server 2019/2022
  Base de datos: SoftwareOA

  Este script crea una base nueva con las tablas, relaciones, restricciones,
  índices, catálogos, configuraciones y auditoría equivalentes al modelo actual.

  Ejecución:
    1. Abrir SQL Server Management Studio o Azure Data Studio.
    2. Conectarse con una cuenta autorizada para crear bases de datos.
    3. Abrir este archivo y ejecutarlo completo.

  El script no elimina ni sobrescribe tablas existentes.
*/

USE [master];
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

IF DB_ID(N'SoftwareOA') IS NULL
BEGIN
    EXEC(N'CREATE DATABASE [SoftwareOA]');
END;
GO

USE [SoftwareOA];
GO

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
GO

IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
BEGIN
    ;THROW 50000, 'El esquema de SoftwareOA ya existe. El script no sobrescribió ninguna tabla.', 1;
END;
GO

BEGIN TRY
    BEGIN TRANSACTION;

    /* Control de migraciones aplicadas */
    CREATE TABLE dbo.schema_migrations (
        [name] NVARCHAR(255) NOT NULL,
        [applied_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_schema_migrations PRIMARY KEY ([name])
    );

    /* Catálogo de roles */
    CREATE TABLE dbo.roles (
        [code] NVARCHAR(20) NOT NULL,
        [description] NVARCHAR(200) NOT NULL,
        CONSTRAINT PK_roles PRIMARY KEY ([code]),
        CONSTRAINT CK_roles_code CHECK ([code] IN (N'CLINICIAN', N'ADMIN'))
    );

    /* Cuentas de acceso */
    CREATE TABLE dbo.users (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_users_id DEFAULT NEWSEQUENTIALID(),
        [email] NVARCHAR(254) COLLATE Latin1_General_100_CI_AI NOT NULL,
        [display_name] NVARCHAR(100) NOT NULL,
        [password_hash] NVARCHAR(512) NOT NULL,
        [role_code] NVARCHAR(20) NOT NULL,
        [active] BIT NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
        [failed_attempts] INT NOT NULL CONSTRAINT DF_users_failed_attempts DEFAULT (0),
        [locked_until] DATETIMEOFFSET(7) NULL,
        [clinician_dni_cipher] VARBINARY(MAX) NULL,
        [clinician_dni_hmac] CHAR(64) NULL,
        [professional_license] NVARCHAR(30) NULL,
        [health_establishment] NVARCHAR(120) NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_users_created_at DEFAULT SYSDATETIMEOFFSET(),
        [updated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_users_updated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_users PRIMARY KEY ([id]),
        CONSTRAINT UQ_users_email UNIQUE ([email]),
        CONSTRAINT FK_users_roles FOREIGN KEY ([role_code])
            REFERENCES dbo.roles ([code])
    );

    /* Credencial MFA de un usuario */
    CREATE TABLE dbo.mfa_credentials (
        [user_id] UNIQUEIDENTIFIER NOT NULL,
        [secret_cipher] VARBINARY(MAX) NOT NULL,
        [enabled] BIT NOT NULL CONSTRAINT DF_mfa_enabled DEFAULT (0),
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_mfa_created_at DEFAULT SYSDATETIMEOFFSET(),
        [verified_at] DATETIMEOFFSET(7) NULL,
        CONSTRAINT PK_mfa_credentials PRIMARY KEY ([user_id]),
        CONSTRAINT FK_mfa_users FOREIGN KEY ([user_id])
            REFERENCES dbo.users ([id]) ON DELETE CASCADE
    );

    /* Sesiones iniciadas */
    CREATE TABLE dbo.sessions (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_sessions_id DEFAULT NEWSEQUENTIALID(),
        [user_id] UNIQUEIDENTIFIER NOT NULL,
        [expires_at] DATETIMEOFFSET(7) NOT NULL,
        [revoked_at] DATETIMEOFFSET(7) NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_sessions_created_at DEFAULT SYSDATETIMEOFFSET(),
        [last_seen_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_sessions_last_seen_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_sessions PRIMARY KEY ([id]),
        CONSTRAINT FK_sessions_users FOREIGN KEY ([user_id])
            REFERENCES dbo.users ([id]) ON DELETE CASCADE
    );

    /* Secuencia para el número correlativo de historia clínica */
    CREATE SEQUENCE dbo.patient_code_seq
        AS BIGINT
        START WITH 1
        INCREMENT BY 1
        MINVALUE 1
        NO CYCLE;

    /* Maestro de pacientes */
    CREATE TABLE dbo.patients (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_patients_id DEFAULT NEWSEQUENTIALID(),
        [medical_record_cipher] VARBINARY(MAX) NOT NULL,
        [medical_record_hmac] CHAR(64) NOT NULL,
        [dni_cipher] VARBINARY(MAX) NOT NULL,
        [dni_hmac] CHAR(64) NOT NULL,
        [names_cipher] VARBINARY(MAX) NOT NULL,
        [surnames_cipher] VARBINARY(MAX) NOT NULL,
        [birth_date_cipher] VARBINARY(MAX) NOT NULL,
        [sex_cipher] VARBINARY(MAX) NULL,
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [owner_clinician_id] UNIQUEIDENTIFIER NOT NULL,
        [archived_at] DATETIMEOFFSET(7) NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_patients_created_at DEFAULT SYSDATETIMEOFFSET(),
        [updated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_patients_updated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_patients PRIMARY KEY ([id]),
        CONSTRAINT UQ_patients_medical_record_hmac UNIQUE ([medical_record_hmac]),
        CONSTRAINT UQ_patients_dni_hmac UNIQUE ([dni_hmac]),
        CONSTRAINT FK_patients_created_by FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id]),
        CONSTRAINT FK_patients_owner FOREIGN KEY ([owner_clinician_id])
            REFERENCES dbo.users ([id])
    );

    /* Contacto del paciente */
    CREATE TABLE dbo.patient_contacts (
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [phone_cipher] VARBINARY(MAX) NOT NULL,
        [email_cipher] VARBINARY(MAX) NULL,
        CONSTRAINT PK_patient_contacts PRIMARY KEY ([patient_id]),
        CONSTRAINT FK_patient_contacts_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]) ON DELETE CASCADE
    );

    /* Perfil clínico actual */
    CREATE TABLE dbo.patient_clinical_profiles (
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [pain_score] DECIMAL(4,2) NULL,
        [obesity] BIT NOT NULL,
        [diabetes] BIT NOT NULL,
        [hypertension] BIT NOT NULL,
        [nicotine_use] BIT NOT NULL,
        [trauma_lower_extremity] BIT NOT NULL,
        [updated_by] UNIQUEIDENTIFIER NOT NULL,
        [updated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_patient_profiles_updated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_patient_clinical_profiles PRIMARY KEY ([patient_id]),
        CONSTRAINT CK_patient_profiles_pain CHECK (
            [pain_score] IS NULL OR [pain_score] BETWEEN 0 AND 10
        ),
        CONSTRAINT FK_patient_profiles_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_patient_profiles_user FOREIGN KEY ([updated_by])
            REFERENCES dbo.users ([id])
    );

    /* Episodios clínicos */
    CREATE TABLE dbo.clinical_episodes (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_clinical_episodes_id DEFAULT NEWSEQUENTIALID(),
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [opened_at] DATE NOT NULL,
        [status] NVARCHAR(10) NOT NULL
            CONSTRAINT DF_clinical_episodes_status DEFAULT N'OPEN',
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinical_episodes_created_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_clinical_episodes PRIMARY KEY ([id]),
        CONSTRAINT CK_clinical_episodes_status CHECK ([status] IN (N'OPEN', N'CLOSED')),
        CONSTRAINT FK_clinical_episodes_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]),
        CONSTRAINT FK_clinical_episodes_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Registro técnico de archivos cifrados */
    CREATE TABLE dbo.stored_assets (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_stored_assets_id DEFAULT NEWSEQUENTIALID(),
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [kind] NVARCHAR(20) NOT NULL,
        [storage_key] NVARCHAR(500) NOT NULL,
        [content_type] NVARCHAR(100) NOT NULL,
        [original_name_cipher] VARBINARY(MAX) NULL,
        [plaintext_sha256] CHAR(64) NOT NULL,
        [size_bytes] BIGINT NOT NULL,
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_stored_assets_created_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_stored_assets PRIMARY KEY ([id]),
        CONSTRAINT UQ_stored_assets_storage_key UNIQUE ([storage_key]),
        CONSTRAINT CK_stored_assets_kind CHECK (
            [kind] IN (N'RADIOGRAPH', N'GRADCAM', N'REPORT')
        ),
        CONSTRAINT CK_stored_assets_size CHECK ([size_bytes] > 0),
        CONSTRAINT FK_stored_assets_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]),
        CONSTRAINT FK_stored_assets_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Validación visual previa de la imagen */
    CREATE TABLE dbo.image_preflight_reviews (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_image_preflight_id DEFAULT NEWSEQUENTIALID(),
        [input_hash] CHAR(64) NOT NULL,
        [file_kind] NVARCHAR(10) NOT NULL,
        [media_type] NVARCHAR(50) NOT NULL,
        [review_status] NVARCHAR(30) NOT NULL,
        [suggested_layout] NVARCHAR(20) NOT NULL,
        [supported] BIT NOT NULL,
        [provider_model] NVARCHAR(200) NOT NULL,
        [provider_request_id] NVARCHAR(255) NULL,
        [cost_usd] DECIMAL(12,8) NULL,
        [assessment] NVARCHAR(MAX) NULL,
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_image_preflight_created_at DEFAULT SYSDATETIMEOFFSET(),
        [expires_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_image_preflight_expires_at
            DEFAULT DATEADD(MINUTE, 30, SYSDATETIMEOFFSET()),
        CONSTRAINT PK_image_preflight_reviews PRIMARY KEY ([id]),
        CONSTRAINT CK_image_preflight_file_kind CHECK (
            [file_kind] IN (N'DICOM', N'RASTER')
        ),
        CONSTRAINT CK_image_preflight_media_type CHECK (
            [media_type] IN (N'application/dicom', N'image/png', N'image/jpeg')
        ),
        CONSTRAINT CK_image_preflight_status CHECK (
            [review_status] IN (
                N'ACCEPTED', N'REJECTED', N'REVIEW_REQUIRED', N'UNAVAILABLE'
            )
        ),
        CONSTRAINT CK_image_preflight_layout CHECK (
            [suggested_layout] IN (N'bilateral', N'single', N'uncertain')
        ),
        CONSTRAINT CK_image_preflight_assessment_json CHECK (
            [assessment] IS NULL OR ISJSON([assessment]) = 1
        ),
        CONSTRAINT FK_image_preflight_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Estudios radiográficos */
    CREATE TABLE dbo.radiographic_studies (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_radiographic_studies_id DEFAULT NEWSEQUENTIALID(),
        [episode_id] UNIQUEIDENTIFIER NOT NULL,
        [asset_id] UNIQUEIDENTIFIER NOT NULL,
        [preflight_id] UNIQUEIDENTIFIER NULL,
        [exam_date] DATE NOT NULL,
        [source_type] NVARCHAR(30) NOT NULL,
        [projection_confirmed] BIT NOT NULL,
        [weight_bearing_confirmed] BIT NOT NULL,
        [orientation_confirmed] BIT NOT NULL,
        [metadata_inverted] BIT NOT NULL
            CONSTRAINT DF_radiographic_studies_inverted DEFAULT (0),
        [horizontal_flip] BIT NOT NULL
            CONSTRAINT DF_radiographic_studies_flip DEFAULT (0),
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_radiographic_studies_created_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_radiographic_studies PRIMARY KEY ([id]),
        CONSTRAINT CK_radiographic_studies_source CHECK (
            [source_type] IN (
                N'DICOM_BILATERAL',
                N'RASTER_BILATERAL',
                N'RASTER_SINGLE_ROI'
            )
        ),
        CONSTRAINT FK_radiographic_studies_episode FOREIGN KEY ([episode_id])
            REFERENCES dbo.clinical_episodes ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_radiographic_studies_asset FOREIGN KEY ([asset_id])
            REFERENCES dbo.stored_assets ([id]),
        CONSTRAINT FK_radiographic_studies_preflight FOREIGN KEY ([preflight_id])
            REFERENCES dbo.image_preflight_reviews ([id]),
        CONSTRAINT FK_radiographic_studies_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Rodilla concreta seleccionada para el análisis */
    CREATE TABLE dbo.knee_observations (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_knee_observations_id DEFAULT NEWSEQUENTIALID(),
        [study_id] UNIQUEIDENTIFIER NOT NULL,
        [knee_side] NCHAR(1) NOT NULL,
        CONSTRAINT PK_knee_observations PRIMARY KEY ([id]),
        CONSTRAINT UQ_knee_observations_study_side UNIQUE ([study_id], [knee_side]),
        CONSTRAINT CK_knee_observations_side CHECK ([knee_side] IN (N'L', N'R')),
        CONSTRAINT FK_knee_observations_study FOREIGN KEY ([study_id])
            REFERENCES dbo.radiographic_studies ([id]) ON DELETE CASCADE
    );

    /* Cola persistente de inferencia */
    CREATE TABLE dbo.inference_jobs (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_inference_jobs_id DEFAULT NEWSEQUENTIALID(),
        [observation_id] UNIQUEIDENTIFIER NOT NULL,
        [job_type] NVARCHAR(20) NOT NULL,
        [status] NVARCHAR(20) NOT NULL
            CONSTRAINT DF_inference_jobs_status DEFAULT N'QUEUED',
        [idempotency_key] NVARCHAR(255) NOT NULL,
        [attempts] INT NOT NULL CONSTRAINT DF_inference_jobs_attempts DEFAULT (0),
        [error_code] NVARCHAR(80) NULL,
        [correlation_id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_inference_jobs_correlation DEFAULT NEWID(),
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_inference_jobs_created_at DEFAULT SYSDATETIMEOFFSET(),
        [started_at] DATETIMEOFFSET(7) NULL,
        [finished_at] DATETIMEOFFSET(7) NULL,
        CONSTRAINT PK_inference_jobs PRIMARY KEY ([id]),
        CONSTRAINT UQ_inference_jobs_idempotency UNIQUE ([idempotency_key]),
        CONSTRAINT CK_inference_jobs_type CHECK ([job_type] IN (N'KL', N'GRADCAM')),
        CONSTRAINT CK_inference_jobs_status CHECK (
            [status] IN (N'QUEUED', N'RUNNING', N'SUCCEEDED', N'FAILED')
        ),
        CONSTRAINT CK_inference_jobs_attempts CHECK ([attempts] >= 0),
        CONSTRAINT FK_inference_jobs_observation FOREIGN KEY ([observation_id])
            REFERENCES dbo.knee_observations ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_inference_jobs_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Resultados de CNN, XGBoost y LSTM */
    CREATE TABLE dbo.model_predictions (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_model_predictions_id DEFAULT NEWSEQUENTIALID(),
        [job_id] UNIQUEIDENTIFIER NULL,
        [observation_id] UNIQUEIDENTIFIER NOT NULL,
        [model_name] NVARCHAR(150) NOT NULL,
        [model_version] NVARCHAR(100) NOT NULL,
        [artifact_hashes] NVARCHAR(MAX) NOT NULL,
        [input_hash] CHAR(64) NOT NULL,
        [input_source] NVARCHAR(100) NOT NULL,
        [knee_side] NCHAR(1) NOT NULL,
        [probabilities] NVARCHAR(MAX) NOT NULL,
        [threshold] FLOAT NULL,
        [screen_positive] BIT NULL,
        [kl_origin] NVARCHAR(100) NULL,
        [latency_ms] FLOAT NULL,
        [device] NVARCHAR(100) NOT NULL,
        [correlation_id] UNIQUEIDENTIFIER NOT NULL,
        [created_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_model_predictions_created_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_model_predictions PRIMARY KEY ([id]),
        CONSTRAINT CK_model_predictions_side CHECK ([knee_side] IN (N'L', N'R')),
        CONSTRAINT CK_model_predictions_hashes_json CHECK (ISJSON([artifact_hashes]) = 1),
        CONSTRAINT CK_model_predictions_probabilities_json CHECK (ISJSON([probabilities]) = 1),
        CONSTRAINT FK_model_predictions_job FOREIGN KEY ([job_id])
            REFERENCES dbo.inference_jobs ([id]),
        CONSTRAINT FK_model_predictions_observation FOREIGN KEY ([observation_id])
            REFERENCES dbo.knee_observations ([id]),
        CONSTRAINT FK_model_predictions_user FOREIGN KEY ([created_by])
            REFERENCES dbo.users ([id])
    );

    /* Mapas Grad-CAM */
    CREATE TABLE dbo.gradcam_explanations (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_gradcam_explanations_id DEFAULT NEWSEQUENTIALID(),
        [prediction_id] UNIQUEIDENTIFIER NOT NULL,
        [backbone] NVARCHAR(100) NOT NULL,
        [asset_id] UNIQUEIDENTIFIER NOT NULL,
        [target_kl] SMALLINT NOT NULL,
        CONSTRAINT PK_gradcam_explanations PRIMARY KEY ([id]),
        CONSTRAINT UQ_gradcam_prediction_backbone UNIQUE ([prediction_id], [backbone]),
        CONSTRAINT CK_gradcam_target_kl CHECK ([target_kl] BETWEEN 0 AND 4),
        CONSTRAINT FK_gradcam_prediction FOREIGN KEY ([prediction_id])
            REFERENCES dbo.model_predictions ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_gradcam_asset FOREIGN KEY ([asset_id])
            REFERENCES dbo.stored_assets ([id])
    );

    /* Revisión clínica de una predicción KL */
    CREATE TABLE dbo.clinician_reviews (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_clinician_reviews_id DEFAULT NEWSEQUENTIALID(),
        [prediction_id] UNIQUEIDENTIFIER NOT NULL,
        [decision] NVARCHAR(20) NOT NULL,
        [confirmed_kl] SMALLINT NULL,
        [reason] NVARCHAR(MAX) NULL,
        [reviewed_by] UNIQUEIDENTIFIER NOT NULL,
        [reviewed_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinician_reviews_reviewed_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_clinician_reviews PRIMARY KEY ([id]),
        CONSTRAINT CK_clinician_reviews_decision CHECK (
            [decision] IN (N'CONFIRMED', N'CORRECTED', N'REJECTED')
        ),
        CONSTRAINT CK_clinician_reviews_kl_range CHECK (
            [confirmed_kl] IS NULL OR [confirmed_kl] BETWEEN 0 AND 4
        ),
        CONSTRAINT CK_clinician_reviews_consistency CHECK (
            ([decision] = N'REJECTED' AND [confirmed_kl] IS NULL)
            OR
            ([decision] <> N'REJECTED' AND [confirmed_kl] IS NOT NULL)
        ),
        CONSTRAINT FK_clinician_reviews_prediction FOREIGN KEY ([prediction_id])
            REFERENCES dbo.model_predictions ([id]),
        CONSTRAINT FK_clinician_reviews_user FOREIGN KEY ([reviewed_by])
            REFERENCES dbo.users ([id])
    );

    /* Fotografía de los datos clínicos en el momento del estudio */
    CREATE TABLE dbo.clinical_observations (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_clinical_observations_id DEFAULT NEWSEQUENTIALID(),
        [knee_observation_id] UNIQUEIDENTIFIER NOT NULL,
        [pain_score] DECIMAL(4,2) NULL,
        [obesity] BIT NOT NULL,
        [diabetes] BIT NOT NULL,
        [hypertension] BIT NOT NULL,
        [nicotine_use] BIT NOT NULL,
        [trauma_lower_extremity] BIT NOT NULL,
        [recorded_by] UNIQUEIDENTIFIER NOT NULL,
        [recorded_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinical_observations_recorded_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_clinical_observations PRIMARY KEY ([id]),
        CONSTRAINT UQ_clinical_observations_knee UNIQUE ([knee_observation_id]),
        CONSTRAINT CK_clinical_observations_pain CHECK (
            [pain_score] IS NULL OR [pain_score] BETWEEN 0 AND 10
        ),
        CONSTRAINT FK_clinical_observations_knee FOREIGN KEY ([knee_observation_id])
            REFERENCES dbo.knee_observations ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_clinical_observations_user FOREIGN KEY ([recorded_by])
            REFERENCES dbo.users ([id])
    );

    /* Exámenes históricos externos */
    CREATE TABLE dbo.prior_exams (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_prior_exams_id DEFAULT NEWSEQUENTIALID(),
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [knee_side] NCHAR(1) NOT NULL,
        [exam_date] DATE NOT NULL,
        [confirmed_kl] SMALLINT NOT NULL,
        [pain_score] DECIMAL(4,2) NULL,
        [obesity] BIT NOT NULL,
        [diabetes] BIT NOT NULL,
        [hypertension] BIT NOT NULL,
        [nicotine_use] BIT NOT NULL,
        [trauma_lower_extremity] BIT NOT NULL,
        [recorded_by] UNIQUEIDENTIFIER NOT NULL,
        CONSTRAINT PK_prior_exams PRIMARY KEY ([id]),
        CONSTRAINT UQ_prior_exams_patient_side_date UNIQUE (
            [patient_id], [knee_side], [exam_date]
        ),
        CONSTRAINT CK_prior_exams_side CHECK ([knee_side] IN (N'L', N'R')),
        CONSTRAINT CK_prior_exams_kl CHECK ([confirmed_kl] BETWEEN 0 AND 4),
        CONSTRAINT CK_prior_exams_pain CHECK (
            [pain_score] IS NULL OR [pain_score] BETWEEN 0 AND 10
        ),
        CONSTRAINT FK_prior_exams_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_prior_exams_user FOREIGN KEY ([recorded_by])
            REFERENCES dbo.users ([id])
    );

    /* Orientaciones clínicas generadas a partir de resultados desidentificados */
    CREATE TABLE dbo.clinical_recommendations (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_clinical_recommendations_id DEFAULT NEWSEQUENTIALID(),
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [observation_id] UNIQUEIDENTIFIER NULL,
        [scope] NVARCHAR(20) NOT NULL,
        [content_cipher] VARBINARY(MAX) NOT NULL,
        [provider_model] NVARCHAR(200) NOT NULL,
        [provider_request_id] NVARCHAR(255) NULL,
        [input_hash] CHAR(64) NOT NULL,
        [cost_usd] DECIMAL(12,8) NULL,
        [generated_by] UNIQUEIDENTIFIER NOT NULL,
        [generated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinical_recommendations_generated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_clinical_recommendations PRIMARY KEY ([id]),
        CONSTRAINT CK_clinical_recommendations_scope CHECK ([scope] IN (N'STUDY', N'PATIENT')),
        CONSTRAINT CK_clinical_recommendations_target CHECK (
            ([scope] = N'STUDY' AND [observation_id] IS NOT NULL) OR
            ([scope] = N'PATIENT' AND [observation_id] IS NULL)
        ),
        CONSTRAINT FK_clinical_recommendations_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]),
        CONSTRAINT FK_clinical_recommendations_observation FOREIGN KEY ([observation_id])
            REFERENCES dbo.knee_observations ([id]),
        CONSTRAINT FK_clinical_recommendations_user FOREIGN KEY ([generated_by])
            REFERENCES dbo.users ([id])
    );

    /* Notas clínicas cifradas por análisis o a nivel general del paciente */
    CREATE TABLE dbo.clinical_notes (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_clinical_notes_id DEFAULT NEWSEQUENTIALID(),
        [patient_id] UNIQUEIDENTIFIER NOT NULL,
        [observation_id] UNIQUEIDENTIFIER NULL,
        [scope] NVARCHAR(20) NOT NULL,
        [content_cipher] VARBINARY(MAX) NOT NULL,
        [updated_by] UNIQUEIDENTIFIER NOT NULL,
        [created_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinical_notes_created_at DEFAULT SYSDATETIMEOFFSET(),
        [updated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_clinical_notes_updated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_clinical_notes PRIMARY KEY ([id]),
        CONSTRAINT CK_clinical_notes_scope CHECK ([scope] IN (N'STUDY', N'PATIENT')),
        CONSTRAINT CK_clinical_notes_target CHECK (
            ([scope] = N'STUDY' AND [observation_id] IS NOT NULL) OR
            ([scope] = N'PATIENT' AND [observation_id] IS NULL)
        ),
        CONSTRAINT FK_clinical_notes_patient FOREIGN KEY ([patient_id])
            REFERENCES dbo.patients ([id]) ON DELETE CASCADE,
        CONSTRAINT FK_clinical_notes_observation FOREIGN KEY ([observation_id])
            REFERENCES dbo.knee_observations ([id]),
        CONSTRAINT FK_clinical_notes_user FOREIGN KEY ([updated_by])
            REFERENCES dbo.users ([id])
    );

    /* Reportes PDF */
    CREATE TABLE dbo.draft_reports (
        [id] UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_draft_reports_id DEFAULT NEWSEQUENTIALID(),
        [episode_id] UNIQUEIDENTIFIER NOT NULL,
        [asset_id] UNIQUEIDENTIFIER NOT NULL,
        [status] NVARCHAR(20) NOT NULL
            CONSTRAINT DF_draft_reports_status DEFAULT N'DRAFT',
        [report_type] NVARCHAR(20) NOT NULL
            CONSTRAINT DF_draft_reports_type DEFAULT N'EPISODE',
        [generated_by] UNIQUEIDENTIFIER NOT NULL,
        [generated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_draft_reports_generated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_draft_reports PRIMARY KEY ([id]),
        CONSTRAINT CK_draft_reports_status CHECK ([status] = N'DRAFT'),
        CONSTRAINT CK_draft_reports_type CHECK (
            [report_type] IN (N'EPISODE', N'LONGITUDINAL')
        ),
        CONSTRAINT FK_draft_reports_episode FOREIGN KEY ([episode_id])
            REFERENCES dbo.clinical_episodes ([id]),
        CONSTRAINT FK_draft_reports_asset FOREIGN KEY ([asset_id])
            REFERENCES dbo.stored_assets ([id]),
        CONSTRAINT FK_draft_reports_user FOREIGN KEY ([generated_by])
            REFERENCES dbo.users ([id])
    );

    /* Auditoría de solo agregado */
    CREATE TABLE dbo.audit_events (
        [id] BIGINT IDENTITY(1,1) NOT NULL,
        [actor_id] UNIQUEIDENTIFIER NULL,
        [action] NVARCHAR(150) NOT NULL,
        [entity_type] NVARCHAR(150) NOT NULL,
        [entity_id] NVARCHAR(255) NULL,
        [correlation_id] UNIQUEIDENTIFIER NULL,
        [metadata] NVARCHAR(MAX) NOT NULL
            CONSTRAINT DF_audit_events_metadata DEFAULT N'{}',
        [occurred_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_audit_events_occurred_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_audit_events PRIMARY KEY ([id]),
        CONSTRAINT CK_audit_events_metadata_json CHECK (ISJSON([metadata]) = 1),
        CONSTRAINT FK_audit_events_user FOREIGN KEY ([actor_id])
            REFERENCES dbo.users ([id])
    );

    /* Configuración institucional */
    CREATE TABLE dbo.app_settings (
        [key] NVARCHAR(100) NOT NULL,
        [value] NVARCHAR(MAX) NOT NULL,
        [updated_by] UNIQUEIDENTIFIER NULL,
        [updated_at] DATETIMEOFFSET(7) NOT NULL
            CONSTRAINT DF_app_settings_updated_at DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT PK_app_settings PRIMARY KEY ([key]),
        CONSTRAINT CK_app_settings_value_json CHECK (ISJSON([value]) = 1),
        CONSTRAINT FK_app_settings_user FOREIGN KEY ([updated_by])
            REFERENCES dbo.users ([id])
    );

    /* Índices de consulta */
    CREATE INDEX IX_users_role_active
        ON dbo.users ([role_code], [active], [created_at] DESC);

    CREATE UNIQUE INDEX UX_users_clinician_dni_hmac
        ON dbo.users ([clinician_dni_hmac])
        WHERE [clinician_dni_hmac] IS NOT NULL;

    CREATE INDEX IX_users_health_establishment
        ON dbo.users ([health_establishment])
        WHERE [role_code] = N'CLINICIAN';

    CREATE INDEX IX_sessions_user
        ON dbo.sessions ([user_id], [expires_at] DESC);

    CREATE INDEX IX_patients_owner_active
        ON dbo.patients ([owner_clinician_id], [created_at] DESC)
        WHERE [archived_at] IS NULL;

    CREATE INDEX IX_patient_profile_updated
        ON dbo.patient_clinical_profiles ([updated_at] DESC);

    CREATE INDEX IX_episode_patient
        ON dbo.clinical_episodes ([patient_id], [opened_at] DESC);

    CREATE INDEX IX_stored_assets_patient_kind
        ON dbo.stored_assets ([patient_id], [kind], [created_at] DESC);

    CREATE INDEX IX_preflight_hash_user
        ON dbo.image_preflight_reviews (
            [input_hash], [created_by], [expires_at] DESC
        );

    CREATE INDEX IX_radiographic_studies_episode
        ON dbo.radiographic_studies ([episode_id], [exam_date] DESC);

    CREATE INDEX IX_jobs_claim
        ON dbo.inference_jobs ([status], [created_at]);

    CREATE INDEX IX_jobs_observation
        ON dbo.inference_jobs ([observation_id], [created_at] DESC);

    /* SQL Server permite un solo NULL en UNIQUE; este índice filtrado conserva
       el comportamiento de PostgreSQL para job_id opcional. */
    CREATE UNIQUE INDEX UX_model_predictions_job
        ON dbo.model_predictions ([job_id])
        WHERE [job_id] IS NOT NULL;

    CREATE INDEX IX_model_predictions_observation
        ON dbo.model_predictions ([observation_id], [created_at] DESC);

    CREATE INDEX IX_clinician_reviews_prediction
        ON dbo.clinician_reviews ([prediction_id], [reviewed_at] DESC);

    CREATE INDEX IX_prior_exams_patient_knee
        ON dbo.prior_exams ([patient_id], [knee_side], [exam_date]);

    CREATE INDEX IX_draft_reports_episode
        ON dbo.draft_reports ([episode_id], [generated_at] DESC);

    CREATE UNIQUE INDEX UX_clinical_recommendations_study
        ON dbo.clinical_recommendations ([observation_id])
        WHERE [scope] = N'STUDY';

    CREATE UNIQUE INDEX UX_clinical_recommendations_patient
        ON dbo.clinical_recommendations ([patient_id])
        WHERE [scope] = N'PATIENT';

    CREATE INDEX IX_clinical_recommendations_patient_date
        ON dbo.clinical_recommendations ([patient_id], [generated_at] DESC);

    CREATE UNIQUE INDEX UX_clinical_notes_study
        ON dbo.clinical_notes ([observation_id])
        WHERE [scope] = N'STUDY';

    CREATE UNIQUE INDEX UX_clinical_notes_patient
        ON dbo.clinical_notes ([patient_id])
        WHERE [scope] = N'PATIENT';

    CREATE INDEX IX_clinical_notes_patient_date
        ON dbo.clinical_notes ([patient_id], [updated_at] DESC);

    CREATE INDEX IX_audit_entity
        ON dbo.audit_events ([entity_type], [entity_id], [occurred_at] DESC);

    CREATE INDEX IX_audit_actor
        ON dbo.audit_events ([actor_id], [occurred_at] DESC);

    /* Datos maestros */
    INSERT INTO dbo.roles ([code], [description])
    VALUES
        (N'CLINICIAN', N'Profesional clínico'),
        (N'ADMIN', N'Administrador técnico');

    INSERT INTO dbo.app_settings ([key], [value])
    VALUES
        (
            N'organization',
            N'{"name":"Clínica OA","reportSubtitle":"Evaluación experimental de osteoartritis"}'
        ),
        (
            N'patientCode',
            N'{"prefix":"OA","digits":6}'
        );

    INSERT INTO dbo.schema_migrations ([name])
    VALUES
        (N'001_initial.sql'),
        (N'002_image_preflight.sql'),
        (N'003_dashboard_and_ownership.sql'),
        (N'004_patient_clinical_profile.sql'),
        (N'005_clinician_identity.sql'),
        (N'sqlserver_equivalent_schema.sql');

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;
    THROW;
END CATCH;
GO

/* Impide editar o eliminar eventos de auditoría. */
CREATE OR ALTER TRIGGER dbo.tr_audit_events_append_only
ON dbo.audit_events
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    ;THROW 50001, 'audit_events es una tabla de solo agregado.', 1;
END;
GO

PRINT N'Base de datos SoftwareOA creada correctamente.';
GO

/* Consultas rápidas de comprobación */
SELECT [code], [description]
FROM dbo.roles
ORDER BY [code];

SELECT [key], [value]
FROM dbo.app_settings
ORDER BY [key];

SELECT
    t.[name] AS [table_name],
    SUM(p.[rows]) AS [row_count]
FROM sys.tables AS t
INNER JOIN sys.partitions AS p
    ON p.[object_id] = t.[object_id]
   AND p.[index_id] IN (0, 1)
GROUP BY t.[name]
ORDER BY t.[name];
GO
