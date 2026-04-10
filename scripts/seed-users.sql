-- Seed/update users for testing
-- Password for all: Sumit1234 (bcrypt 12 rounds)

-- 1. sk@daksfirst.com → Admin
INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
VALUES ('admin', 'SK', 'Daksfirst', 'sk@daksfirst.com', '0000000000', '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka', true)
ON CONFLICT (email) DO UPDATE SET
  role = 'admin',
  password_hash = '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka',
  email_verified = true;

-- 2. sumitkanthed@gmail.com → Broker
INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
VALUES ('broker', 'Sumit', 'Kanthed', 'sumitkanthed@gmail.com', '0000000000', '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka', true)
ON CONFLICT (email) DO UPDATE SET
  role = 'broker',
  password_hash = '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka',
  email_verified = true;

-- 3. kantheduk@gmail.com → Borrower
INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
VALUES ('borrower', 'Kanthed', 'UK', 'kantheduk@gmail.com', '0000000000', '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka', true)
ON CONFLICT (email) DO UPDATE SET
  role = 'borrower',
  password_hash = '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka',
  email_verified = true;

-- 4. mumalkanthed@gmail.com → Credit
INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
VALUES ('credit', 'Mumal', 'Kanthed', 'mumalkanthed@gmail.com', '0000000000', '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka', true)
ON CONFLICT (email) DO UPDATE SET
  role = 'credit',
  password_hash = '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka',
  email_verified = true;

-- 5. avantiwelfaretrust@gmail.com → RM
INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
VALUES ('rm', 'Avanti', 'Welfare', 'avantiwelfaretrust@gmail.com', '0000000000', '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka', true)
ON CONFLICT (email) DO UPDATE SET
  role = 'rm',
  password_hash = '$2b$12$xLSdqLE57aibHA1hB3psn.3Fbwn3bEO2gFC2.Rum.80tffxl/kPka',
  email_verified = true;

-- Verify
SELECT id, email, role, email_verified FROM users WHERE email IN (
  'sk@daksfirst.com',
  'sumitkanthed@gmail.com',
  'kantheduk@gmail.com',
  'mumalkanthed@gmail.com',
  'avantiwelfaretrust@gmail.com'
);
