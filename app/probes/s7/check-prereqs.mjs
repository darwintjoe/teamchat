const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN_A",
  "GOOGLE_REFRESH_TOKEN_B",
  "GOOGLE_ACCOUNT_B_EMAIL",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(
    JSON.stringify(
      {
        test: "S7",
        status: "BLOCKED",
        missing,
        needed:
          "Google Cloud project, OAuth client (Desktop app), consent screen in Testing with the drive.file scope, two test Google accounts A and B, and refresh tokens for both.",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

console.log(JSON.stringify({ test: "S7", status: "READY", checked: required }, null, 2));
