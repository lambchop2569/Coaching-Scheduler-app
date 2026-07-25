import { DiscordSDK } from '@discord/embedded-app-sdk';
export async function startActivity() {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
        console.warn('DISCORD_CLIENT_ID is not configured; skipping embedded app startup');
        return null;
    }
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    await sdk.ready();
    console.log('Discord embedded app shell initialized');
    return sdk;
}
