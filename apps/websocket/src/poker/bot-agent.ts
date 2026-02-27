import WebSocket from 'ws';
import type { Card, Rank, GamePhase } from '@poker/types';

const RANK_VALUES: Record<Rank, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    '10': 10, J: 11, Q: 12, K: 13, A: 14,
};

export interface BotConfig {
    userId: string;
    username: string;
    token: string;
    roomId: string;
    seatNumber: number;
    wsUrl: string;
}

interface BotGameState {
    phase: GamePhase;
    pot: number;
    communityCards: Card[];
    currentPlayerIndex: number;
    currentBet: number;
    minRaise: number;
    players: Array<{
        userId: string;
        username: string;
        seatNumber: number;
        stack: number;
        status: string;
        currentBet: number;
    }>;
    yourCards?: Card[];
}

export class BotAgent {
    private ws: WebSocket | null = null;
    private config: BotConfig;
    private holeCards: Card[] = [];
    private currentGameState: BotGameState | null = null;
    private isConnected = false;
    private isAuthenticated = false;
    private isInRoom = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private actionTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingAction = false;
    private stopped = false;

    constructor(config: BotConfig) {
        this.config = config;
    }

    get username(): string {
        return this.config.username;
    }

    async start(): Promise<void> {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.isAuthenticated = false;
        this.isInRoom = false;
        console.log(`[BotAgent] ${this.config.username} stopped`);
    }

    private connect(): void {
        if (this.stopped) return;

        try {
            this.ws = new WebSocket(this.config.wsUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                console.log(`[BotAgent] ${this.config.username} connected to WebSocket`);
                this.authenticate();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (err) {
                    console.error(`[BotAgent] ${this.config.username} failed to parse message:`, err);
                }
            });

            this.ws.on('close', () => {
                this.isConnected = false;
                this.isAuthenticated = false;
                this.isInRoom = false;
                if (!this.stopped) {
                    console.log(`[BotAgent] ${this.config.username} disconnected, reconnecting in 5s...`);
                    this.scheduleReconnect();
                }
            });

            this.ws.on('error', (err) => {
                console.error(`[BotAgent] ${this.config.username} WebSocket error:`, err.message);
            });
        } catch (err) {
            console.error(`[BotAgent] ${this.config.username} connection error:`, err);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    private send(message: { type: string; payload: Record<string, unknown> }): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private authenticate(): void {
        this.send({
            type: 'auth',
            payload: { token: this.config.token },
        });
    }

    private joinRoom(): void {
        this.send({
            type: 'join_room',
            payload: {
                roomId: this.config.roomId,
                seatNumber: this.config.seatNumber,
                buyIn: 0, // Already handled via HTTP API
            },
        });
    }

    private handleMessage(message: { type: string; payload: any }): void {
        switch (message.type) {
            case 'auth_success':
                this.isAuthenticated = true;
                console.log(`[BotAgent] ${this.config.username} authenticated`);
                this.joinRoom();
                break;

            case 'joined_room':
                this.isInRoom = true;
                console.log(`[BotAgent] ${this.config.username} joined room (seat ${message.payload.seatNumber}, stack ${message.payload.stack})`);
                break;

            case 'game_state':
                this.handleGameState(message.payload);
                break;

            case 'new_round':
                this.currentGameState = message.payload;
                // Reset for new round
                this.holeCards = [];
                this.pendingAction = false;
                if (this.actionTimer) {
                    clearTimeout(this.actionTimer);
                    this.actionTimer = null;
                }
                break;

            case 'hand_result':
                // Reset action state on hand end
                this.pendingAction = false;
                if (this.actionTimer) {
                    clearTimeout(this.actionTimer);
                    this.actionTimer = null;
                }
                break;

            case 'player_sat_out':
                if (message.payload.userId === this.config.userId) {
                    console.log(`[BotAgent] ${this.config.username} was sat out (${message.payload.reason}). Stopping.`);
                    this.isInRoom = false;
                    // Don't reconnect - agent manager will handle restart
                    this.stop();
                }
                break;

            case 'error':
                console.error(`[BotAgent] ${this.config.username} error: ${message.payload.message}`);
                break;
        }
    }

    private handleGameState(state: BotGameState): void {
        this.currentGameState = state;

        // Store hole cards if provided
        if (state.yourCards && state.yourCards.length > 0) {
            this.holeCards = state.yourCards;
        }

        // Check if it's our turn
        if (!state.players || state.currentPlayerIndex === undefined) return;

        const currentPlayer = state.players[state.currentPlayerIndex];
        if (!currentPlayer || currentPlayer.userId !== this.config.userId) return;

        // Guard: don't schedule another action if one is already pending
        if (this.pendingAction) return;
        this.pendingAction = true;

        // It's our turn! Decide action with a human-like delay
        const delay = 1500 + Math.random() * 2500; // 1.5-4 seconds
        this.actionTimer = setTimeout(() => {
            this.actionTimer = null;
            this.decideAction(state);
        }, delay);
    }

    private decideAction(state: BotGameState): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const myPlayer = state.players.find(p => p.userId === this.config.userId);
        if (!myPlayer || myPlayer.status !== 'active') return;

        const phase = state.phase;
        const handStrength = this.evaluateHandStrength(phase, state.communityCards);
        const callAmount = state.currentBet - myPlayer.currentBet;
        const canCheck = callAmount <= 0;

        let action: string;
        let amount: number | undefined;

        // Get action probabilities based on hand strength
        const probs = this.getActionProbabilities(handStrength, phase, canCheck, callAmount, myPlayer.stack);
        const roll = Math.random();

        if (roll < probs.fold) {
            // Fold (but check if we can check instead)
            if (canCheck) {
                action = 'check';
            } else {
                action = 'fold';
            }
        } else if (roll < probs.fold + probs.callCheck) {
            // Call or Check
            if (canCheck) {
                action = 'check';
            } else if (callAmount >= myPlayer.stack) {
                action = 'all-in';
            } else {
                action = 'call';
            }
        } else {
            // Raise
            if (myPlayer.stack <= callAmount + state.minRaise) {
                action = 'all-in';
            } else {
                action = 'raise';
                // Raise between 2x-3x big blind or 2x-3x current bet
                const minRaise = state.minRaise;
                const maxRaise = Math.min(myPlayer.stack - callAmount, state.pot * 2);
                const raiseMultiplier = 1 + Math.random() * 1.5; // 1x-2.5x min raise
                amount = Math.max(minRaise, Math.floor(minRaise * raiseMultiplier));
                amount = Math.min(amount, maxRaise);

                // Occasionally go all-in on very strong hands
                if (handStrength > 0.85 && Math.random() < 0.3) {
                    action = 'all-in';
                    amount = undefined;
                }
            }
        }

        console.log(`[BotAgent] ${this.config.username} action: ${action}${amount ? ` (${amount})` : ''} | strength: ${handStrength.toFixed(2)} | phase: ${phase}`);

        this.pendingAction = false; // Reset for next turn
        this.send({
            type: 'player_action',
            payload: { action, amount },
        });
    }

    private getActionProbabilities(
        strength: number,
        phase: GamePhase,
        canCheck: boolean,
        callAmount: number,
        stack: number
    ): { fold: number; callCheck: number; raise: number } {
        // Pot odds consideration: if call is small relative to stack, be more willing to call
        const callRatio = stack > 0 ? callAmount / stack : 1;

        if (phase === 'preflop') {
            if (strength > 0.8) {
                // Premium hand (AA-JJ, AKs)
                return { fold: 0, callCheck: 0.3, raise: 0.7 };
            } else if (strength > 0.6) {
                // Good hand (TT-77, AQ-AJ)
                return { fold: 0.05, callCheck: 0.55, raise: 0.4 };
            } else if (strength > 0.4) {
                // Playable (suited connectors, mid pairs)
                return { fold: canCheck ? 0 : 0.2, callCheck: 0.6, raise: canCheck ? 0.2 : 0.2 };
            } else {
                // Weak hand
                return { fold: canCheck ? 0 : 0.65, callCheck: canCheck ? 0.85 : 0.25, raise: canCheck ? 0.15 : 0.1 };
            }
        } else {
            // Post-flop
            if (strength > 0.75) {
                // Strong made hand
                return { fold: 0, callCheck: 0.3, raise: 0.7 };
            } else if (strength > 0.5) {
                // Medium hand
                return { fold: canCheck ? 0 : 0.1, callCheck: 0.6, raise: 0.3 };
            } else if (strength > 0.3) {
                // Draw or weak pair
                const foldChance = canCheck ? 0 : (callRatio > 0.3 ? 0.5 : 0.25);
                return { fold: foldChance, callCheck: canCheck ? 0.8 : 0.4, raise: 0.15 };
            } else {
                // Nothing
                const foldChance = canCheck ? 0 : (callRatio > 0.15 ? 0.7 : 0.5);
                return { fold: foldChance, callCheck: canCheck ? 0.8 : 0.2, raise: canCheck ? 0.2 : 0.1 };
            }
        }
    }

    /**
     * Evaluate hand strength as a value between 0 and 1.
     * Preflop: based on hole card rankings.
     * Postflop: rough estimation based on pairs, draws, etc.
     */
    private evaluateHandStrength(phase: GamePhase, communityCards: Card[]): number {
        if (this.holeCards.length < 2) return 0.3; // Unknown, play cautiously

        const card1 = this.holeCards[0];
        const card2 = this.holeCards[1];
        const v1 = RANK_VALUES[card1.rank];
        const v2 = RANK_VALUES[card2.rank];
        const highCard = Math.max(v1, v2);
        const lowCard = Math.min(v1, v2);
        const isPair = v1 === v2;
        const isSuited = card1.suit === card2.suit;
        const gap = highCard - lowCard;

        if (phase === 'preflop') {
            return this.preflopStrength(highCard, lowCard, isPair, isSuited, gap);
        }

        // Post-flop: evaluate against community cards
        return this.postflopStrength(communityCards);
    }

    private preflopStrength(
        high: number, low: number, isPair: boolean, isSuited: boolean, gap: number
    ): number {
        // Pocket pairs
        if (isPair) {
            if (high >= 11) return 0.9;  // JJ+
            if (high >= 8) return 0.7;   // 88-TT
            if (high >= 5) return 0.55;  // 55-77
            return 0.45;                  // 22-44
        }

        // Ace-high
        if (high === 14) {
            if (low >= 12) return isSuited ? 0.85 : 0.8; // AK, AQ
            if (low >= 10) return isSuited ? 0.7 : 0.65;  // AJ, AT
            if (isSuited) return 0.55;                     // Ax suited
            return 0.35;                                    // Ax offsuit
        }

        // King-high
        if (high === 13) {
            if (low >= 11) return isSuited ? 0.7 : 0.6;   // KQ, KJ
            if (low >= 10) return isSuited ? 0.55 : 0.45;  // KT
            return isSuited ? 0.4 : 0.25;
        }

        // Suited connectors
        if (isSuited && gap <= 2 && low >= 6) return 0.5;
        if (isSuited && gap <= 1) return 0.45;

        // Connected cards
        if (gap <= 1 && low >= 8) return 0.45;
        if (gap <= 2 && low >= 7) return 0.35;

        // Everything else
        if (isSuited) return 0.3;
        if (high >= 10 && low >= 8) return 0.3;
        return 0.15;
    }

    private postflopStrength(communityCards: Card[]): number {
        if (!communityCards || communityCards.length === 0) return 0.3;

        const allCards = [...this.holeCards, ...communityCards];
        const myValues = this.holeCards.map(c => RANK_VALUES[c.rank]);
        const communityValues = communityCards.map(c => RANK_VALUES[c.rank]);

        // Count matches between hole cards and community
        let pairs = 0;
        let trips = 0;
        let overCards = 0;

        for (const holeCard of this.holeCards) {
            const holeValue = RANK_VALUES[holeCard.rank];
            let matchCount = 0;

            for (const commCard of communityCards) {
                if (commCard.rank === holeCard.rank) {
                    matchCount++;
                }
            }

            if (matchCount >= 2) trips++;
            else if (matchCount === 1) pairs++;

            // Over card: hole card higher than all community cards
            const maxCommunity = Math.max(...communityValues);
            if (holeValue > maxCommunity) overCards++;
        }

        // Check for flush draw
        const suitCounts = new Map<string, number>();
        for (const card of allCards) {
            suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);
        }
        const maxSuitCount = Math.max(...suitCounts.values());
        const hasFlush = maxSuitCount >= 5;
        const hasFlushDraw = maxSuitCount === 4;

        // Check for straight potential (simplified)
        const uniqueValues = [...new Set(allCards.map(c => RANK_VALUES[c.rank]))].sort((a, b) => a - b);
        let maxConsecutive = 1;
        let consecutive = 1;
        for (let i = 1; i < uniqueValues.length; i++) {
            if (uniqueValues[i] - uniqueValues[i - 1] === 1) {
                consecutive++;
                maxConsecutive = Math.max(maxConsecutive, consecutive);
            } else {
                consecutive = 1;
            }
        }
        const hasStraight = maxConsecutive >= 5;
        const hasStraightDraw = maxConsecutive === 4;

        // Score the hand
        if (hasFlush || hasStraight) return 0.85;
        if (trips > 0) return 0.8;
        if (pairs >= 2) return 0.75;
        if (pairs === 1) {
            const pairedValue = this.holeCards.find(c =>
                communityCards.some(cc => cc.rank === c.rank)
            );
            if (pairedValue && RANK_VALUES[pairedValue.rank] >= 10) return 0.65; // Top pair
            if (pairedValue && RANK_VALUES[pairedValue.rank] >= 7) return 0.55;  // Mid pair
            return 0.45; // Low pair
        }
        if (hasFlushDraw || hasStraightDraw) return 0.4;
        if (overCards >= 2) return 0.35;
        if (overCards === 1) return 0.25;
        return 0.15;
    }
}
