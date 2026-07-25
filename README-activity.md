# Discord Activity setup

This project now includes a minimal Discord Activity shell under public/index.html.

## Local preview
Run:

```bash
npm run activity
```

Then open http://localhost:3000/.

## Discord app configuration
To turn it into a real embedded app, you will need to:
1. Create a Discord application and enable the Embedded App / Activities feature.
2. Set the application ID in .env as DISCORD_CLIENT_ID.
3. Host the public folder behind HTTPS.
4. Register the public URL in the Discord app configuration.
5. Launch the activity from Discord using that URL.
