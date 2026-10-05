# Global Timetable Generator

Global Timetable Generator is a browser-based application for configuring, generating, reviewing, editing, and exporting academic timetables. It includes department-specific scheduling implementations and a department-neutral scheduling path.

## Features

- Configure academic department, year, semester, sections, staff, subjects, labs, special activities, and teacher assignments.
- Generate and validate schedules with scheduling rules for subject placement, teacher occupancy, lab and activity blocks, and placement periods.
- Choose random allocation or custom subject selection for supported placement alternate-week schedules.
- Review and edit generated timetables, with validation before edited schedules are saved.
- Save timetable versions, restore versions, and lock or unlock saved versions.
- View teacher and consolidated faculty timetables, and export timetable views for printing or as PDF/PNG files.

The department options in the interface are CSE, IT, AIML, ECE, EEE, IOT, RA, FT, and MECH. Available scheduling behavior can vary by department and configuration.

## Technology

- React and TypeScript, built and served with Vite
- Node.js built-in SQLite (`node:sqlite`) for saved timetable persistence
- `html2canvas` and `jspdf` for timetable exports
- pnpm for package management

## Project Structure

- `src/`: application interface, timetable models, scheduling implementations, editing, exports, and teacher timetable views
- `backend/`: SQLite repository, same-origin timetable-version API middleware, and SQL migrations
- `tests/`: Node.js test suite
- `public/`: static image assets
- `data/`: default local SQLite database location; runtime database files are not source-controlled
- `vite.config.ts`: Vite configuration, including the timetable API middleware

## Requirements

- Node.js 24 (the project uses `node:sqlite`; Node 24 is verified for this project)
- pnpm

## Setup and Commands

Install dependencies:

```sh
pnpm install
```

Start the development server:

```sh
pnpm dev
```

Run the tests, TypeScript checks, or production build:

```sh
pnpm test
pnpm typecheck
pnpm build
```

After building, `pnpm preview` serves the Vite preview. Both Vite development and preview servers mount the timetable-version API middleware.

## Database and Environment

Timetable persistence uses the shared PostgreSQL database specified by `DATABASE_URL`. The repository applies pending PostgreSQL migrations when it connects. Configure `DATABASE_URL` in the server environment (or in a local, Git-ignored `.env` file); the connection string is never used in the browser.

For local development, copy `.env.example` to `.env`, supply the PostgreSQL connection string, and start Vite:

```powershell
pnpm dev
```

`.env.example` contains only the `DATABASE_URL=` placeholder. Do not commit local `.env` files or database credentials.

## Production Notes

`pnpm build` creates the frontend build in `dist/`. The timetable-version API is attached to Vite's development and preview servers; the Render service uses the preview server and must have `DATABASE_URL` set in its environment. A static-only deployment of `dist/` does not provide the persistence endpoints.