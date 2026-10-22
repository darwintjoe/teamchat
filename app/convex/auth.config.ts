// JWT verification config for Convex Auth. The provider domain is this deployment's own site URL.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
