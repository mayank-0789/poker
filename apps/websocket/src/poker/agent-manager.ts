import { db, users, rooms, tablePlayers, eq, and } from '@poker/db';
import { BotAgent, BotConfig } from './bot-agent';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const BACKEND_URL = `http://localhost:${process.env.PORT || '3000'}`;
const WS_URL = `ws://localhost:${process.env.PORT || process.env.WS_PORT || '3001'}`;

const BOT_COUNT = parseInt(process.env.BOT_COUNT || '4');
const BOT_TABLE_NAME = process.env.BOT_TABLE_NAME || 'Bot Arena';
const BOT_SMALL_BLIND = parseInt(process.env.BOT_SMALL_BLIND || '50');
const BOT_BIG_BLIND = parseInt(process.env.BOT_BIG_BLIND || '100');
const BOT_BUY_IN = parseInt(process.env.BOT_BUY_IN || '5000');
const BOT_MAX_PLAYERS = Math.max(BOT_COUNT, 2);

const BOT_NAMES = [
    'bot_alice', 'bot_bob', 'bot_charlie', 'bot_diana',
    'bot_eddie', 'bot_fiona', 'bot_george', 'bot_hannah',
    'bot_ivan',
];

interface BotAccount {
    id: string;
    username: string;
    email: string;
    token: string;
}

export class AgentManager {
    private bots: BotAgent[] = [];
    private botAccounts: BotAccount[] = [];
    private roomId: string | null = null;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    async start(): Promise<void> {
        console.log('[AgentManager] Starting autonomous poker bot system...');

        try {
            // Step 1: Ensure bot accounts exist in DB
            await this.ensureBotAccounts();

            // Step 2: Create or find a bot room
            await this.ensureBotRoom();

            // Step 3: Join bots to the room via HTTP API
            await this.joinBotsToRoom();

            // Step 4: Start bot WebSocket connections
            await this.startBots();

            // Step 5: Start health monitoring
            this.startHealthCheck();

            console.log(`[AgentManager] ✅ ${this.bots.length} bots active in room "${BOT_TABLE_NAME}"`);
        } catch (err) {
            console.error('[AgentManager] Failed to start:', err);
        }
    }

    async stop(): Promise<void> {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        for (const bot of this.bots) {
            bot.stop();
        }
        this.bots = [];
        console.log('[AgentManager] Stopped all bots');
    }

    private async ensureBotAccounts(): Promise<void> {
        const count = Math.min(BOT_COUNT, BOT_NAMES.length);
        this.botAccounts = [];

        for (let i = 0; i < count; i++) {
            const username = BOT_NAMES[i];
            const email = `${username}@bot.poker`;
            const password = `bot_password_${username}_secure`;

            // Check if account already exists
            const [existing] = await db
                .select()
                .from(users)
                .where(eq(users.username, username))
                .limit(1);

            let userId: string;

            if (existing) {
                userId = existing.id;

                // Ensure bot has enough balance to buy in
                if (existing.balance < BOT_BUY_IN) {
                    await db
                        .update(users)
                        .set({ balance: 50000 })
                        .where(eq(users.id, existing.id));
                }
            } else {
                // Create new bot account
                const passwordHash = await bcrypt.hash(password, 10);
                const [newUser] = await db
                    .insert(users)
                    .values({
                        email,
                        username,
                        passwordHash,
                        balance: 50000,
                        isAdmin: false,
                    })
                    .returning();
                userId = newUser.id;
                console.log(`[AgentManager] Created bot account: ${username}`);
            }

            // Generate JWT token directly (we have access to the secret)
            const token = jwt.sign(
                { userId, email, username, isAdmin: false },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            this.botAccounts.push({ id: userId, username, email, token });
        }

        console.log(`[AgentManager] ${this.botAccounts.length} bot accounts ready: ${this.botAccounts.map(b => b.username).join(', ')}`);
    }

    private async ensureBotRoom(): Promise<void> {
        // Look for an existing bot room that's still active
        const existingRooms = await db
            .select()
            .from(rooms)
            .where(and(eq(rooms.name, BOT_TABLE_NAME), eq(rooms.status, 'waiting')))
            .limit(1);

        if (existingRooms.length > 0) {
            this.roomId = existingRooms[0].id;
            console.log(`[AgentManager] Using existing room: ${BOT_TABLE_NAME} (${this.roomId})`);

            // Clean up any stale players from this room
            await db.delete(tablePlayers).where(eq(tablePlayers.roomId, this.roomId));
            return;
        }

        // Create a new room (use the first bot as the creator)
        const creatorId = this.botAccounts[0].id;

        const [newRoom] = await db
            .insert(rooms)
            .values({
                name: BOT_TABLE_NAME,
                smallBlind: BOT_SMALL_BLIND,
                bigBlind: BOT_BIG_BLIND,
                minBuyIn: BOT_BIG_BLIND * 10,
                maxBuyIn: BOT_BUY_IN * 2,
                maxPlayers: Math.min(BOT_MAX_PLAYERS + 3, 9), // Leave room for human players
                status: 'waiting',
                createdBy: creatorId,
            })
            .returning();

        this.roomId = newRoom.id;
        console.log(`[AgentManager] Created bot room: ${BOT_TABLE_NAME} (${this.roomId})`);
    }

    private async joinBotsToRoom(): Promise<void> {
        if (!this.roomId) {
            throw new Error('No room ID available');
        }

        for (let i = 0; i < this.botAccounts.length; i++) {
            const bot = this.botAccounts[i];
            const seatNumber = i + 1;

            // Check if already at the table
            const [existing] = await db
                .select()
                .from(tablePlayers)
                .where(
                    and(
                        eq(tablePlayers.roomId, this.roomId),
                        eq(tablePlayers.userId, bot.id)
                    )
                )
                .limit(1);

            if (existing) {
                continue;
            }

            // Deduct buy-in from balance
            const [userData] = await db
                .select()
                .from(users)
                .where(eq(users.id, bot.id))
                .limit(1);

            if (!userData || userData.balance < BOT_BUY_IN) {
                // Top up balance
                await db
                    .update(users)
                    .set({ balance: 50000 })
                    .where(eq(users.id, bot.id));
            }

            // Deduct buy-in
            const currentBalance = userData ? userData.balance : 50000;
            await db
                .update(users)
                .set({ balance: currentBalance - BOT_BUY_IN })
                .where(eq(users.id, bot.id));

            // Add player to table
            await db
                .insert(tablePlayers)
                .values({
                    roomId: this.roomId,
                    userId: bot.id,
                    seatNumber,
                    stack: BOT_BUY_IN,
                    status: 'waiting',
                });

            console.log(`[AgentManager] ${bot.username} joined room at seat ${seatNumber} with ${BOT_BUY_IN} chips`);
        }
    }

    private async startBots(): Promise<void> {
        if (!this.roomId) {
            throw new Error('No room ID available');
        }

        for (let i = 0; i < this.botAccounts.length; i++) {
            const account = this.botAccounts[i];
            const seatNumber = i + 1;

            const config: BotConfig = {
                userId: account.id,
                username: account.username,
                token: account.token,
                roomId: this.roomId,
                seatNumber,
                wsUrl: WS_URL,
            };

            const bot = new BotAgent(config);

            // Stagger bot connections slightly
            await new Promise(resolve => setTimeout(resolve, 500));
            await bot.start();

            this.bots.push(bot);
        }
    }

    private startHealthCheck(): void {
        // Every 2 minutes, check if bots are still alive
        this.healthCheckTimer = setInterval(async () => {
            console.log(`[AgentManager] Health check: ${this.bots.length} bots running`);
        }, 120000);
    }
}
