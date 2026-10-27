@echo off
echo ============================================
echo YEBS Noodles - Quick Start Installation
echo ============================================
echo.

echo Step 1: Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
)
echo ✓ Dependencies installed
echo.

echo Step 2: Checking for .env file...
if not exist .env (
    echo Creating .env from template...
    copy .env.example .env
    echo.
    echo ⚠ IMPORTANT: Edit .env file and configure:
    echo   - DATABASE_URL
    echo   - JWT_SECRET
    echo   - MTN MoMo credentials (if ready)
    echo.
    pause
)
echo ✓ Environment file exists
echo.

echo Step 3: Generating Prisma client...
call npx prisma generate
if %errorlevel% neq 0 (
    echo ERROR: Prisma generate failed
    pause
    exit /b 1
)
echo ✓ Prisma client generated
echo.

echo Step 4: Running database migrations...
echo (Make sure PostgreSQL is running and DATABASE_URL is configured)
call npx prisma migrate dev --name init
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Database migration failed.
    echo.
    echo Make sure:
    echo 1. PostgreSQL is installed and running
    echo 2. DATABASE_URL in .env is correct
    echo.
    echo Quick PostgreSQL setup with Docker:
    echo   docker run --name yebs-postgres -e POSTGRES_PASSWORD=yebs123 -e POSTGRES_DB=yebs_noodles -p 5432:5432 -d postgres:15
    echo.
    echo Then set in .env:
    echo   DATABASE_URL=postgresql://postgres:yebs123@localhost:5432/yebs_noodles
    echo.
    pause
    exit /b 1
)
echo ✓ Database migrated
echo.

echo Step 5: Seeding initial data...
call npx prisma db seed
if %errorlevel% neq 0 (
    echo Warning: Seed failed, but you can continue
)
echo ✓ Database seeded
echo.

echo ============================================
echo ✓ Installation Complete!
echo ============================================
echo.
echo Your YEBS Noodles platform is ready!
echo.
echo To start the development server, run:
echo   npm run dev
echo.
echo Then visit:
echo   • Customer: http://localhost:3000
echo   • Driver:   http://localhost:3000/driver
echo   • Admin:    http://localhost:3000/admin
echo.
echo Default admin login:
echo   Username: yebsnoodles
echo   Password: yebs@123
echo.
echo Next steps:
echo 1. Test all three portals locally
echo 2. Configure MTN MoMo in .env (get credentials from momodeveloper.mtn.com)
echo 3. Deploy to production (see INSTALLATION.md)
echo.
echo Need help? Check:
echo   • README.md - Quick start guide
echo   • INSTALLATION.md - Production deployment
echo   • PRODUCTION_ROADMAP.md - Feature implementation
echo   • NEXT_STEPS.md - Action plan
echo.
pause
