// Convex components used by this app.
// The transactional rate limiter (CR-6: "no external Redis, no hand-rolled counter table").
import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp();
app.use(rateLimiter);

export default app;
