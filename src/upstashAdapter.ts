import type { SchedulerData, BookedSession } from './index.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_REST_API;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_REST_PASSWORD;
const UPSTASH_AVAILABLE = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function upRequest(body: unknown) {
    if (!UPSTASH_URL) throw new Error('Upstash URL not configured');
    const url = `${UPSTASH_URL.replace(/\/$/, '')}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${UPSTASH_TOKEN}`
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upstash request failed ${res.status}: ${text}`);
    }

    return res.json();
}

export async function upGetSchedulerData(): Promise<SchedulerData | null> {
    if (!UPSTASH_AVAILABLE) return null;
    try {
        const r = await upRequest(['GET', 'scheduler:data']);
        if (!r || !('result' in r)) return null;
        const val = r.result;
        return val ? JSON.parse(val) : null;
    } catch (err: any) {
        console.error('Upstash get(scheduler:data) failed', err);
        return null;
    }
}

export async function upSetSchedulerData(data: SchedulerData): Promise<boolean> {
    if (!UPSTASH_AVAILABLE) return false;
    try {
        await upRequest(['SET', 'scheduler:data', JSON.stringify(data)]);
        return true;
    } catch (err: any) {
        console.error('Upstash set(scheduler:data) failed', err);
        return false;
    }
}

export async function upGetAppointments(): Promise<BookedSession[] | null> {
    if (!UPSTASH_AVAILABLE) return null;
    try {
        const r = await upRequest(['GET', 'scheduler:appointments']);
        const val = r.result;
        return val ? JSON.parse(val) : [];
    } catch (err: any) {
        console.error('Upstash get(scheduler:appointments) failed', err);
        return null;
    }
}

export async function upSetAppointments(sessions: BookedSession[]): Promise<boolean> {
    if (!UPSTASH_AVAILABLE) return false;
    try {
        await upRequest(['SET', 'scheduler:appointments', JSON.stringify(sessions)]);
        return true;
    } catch (err: any) {
        console.error('Upstash set(scheduler:appointments) failed', err);
        return false;
    }
}

export const upstashAvailable = UPSTASH_AVAILABLE;
