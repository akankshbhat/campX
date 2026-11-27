# CampX

## Run locally

Requires Node.js 22.13 or newer. From this folder, run:

```powershell
npm.cmd start
```

Open [http://localhost:5000](http://localhost:5000). On first start, CampX creates a SQLite database at `data/campx.sqlite` and stores uploaded listing photos in `uploads/`. No database server or package installation is needed.

Create an account with the **List an item** or **Log in** button. Registration, login and listing use your official `@bmsce.ac.in` email address; other domains are rejected. There is no email verification or OTP step. Payments and deposit settlements are arranged offline between students.

Optional `.env` settings:

```text
PORT=5000
HOST=127.0.0.1
JWT_SECRET=replace-with-a-long-random-secret
CLIENT_ORIGIN=http://127.0.0.1:5500
```

`CLIENT_ORIGIN` is only needed when serving the frontend from a separate development origin, such as VS Code Live Server. Keep `HOST` on localhost unless you intend to expose the development server to your network. When running behind a proxy or using the app beyond local development, set a private `JWT_SECRET` and configure HTTPS.

Run the API tests with `npm.cmd test`.
