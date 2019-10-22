/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import Bluebird from "bluebird";
import * as promiseutil from "../promiseutil";
import { EventEmitter } from "events";
import Ident from "./Ident"
import { ConnectionInstance, InstanceDisconnectReason, IrcMessage } from "./ConnectionInstance";
import { IrcRoom } from "../models/IrcRoom";
import { getLogger } from "../logging";
import { IrcServer } from "./IrcServer";
import { IrcClientConfig } from "../models/IrcClientConfig";
import { MatrixUser } from "matrix-appservice-bridge";
import { LoggerInstance } from "winston";
import { IrcAction } from "../models/IrcAction";
import { IdentGenerator } from "./IdentGenerator";
import { Ipv6Generator } from "./Ipv6Generator";
import { IrcEventBroker } from "./IrcEventBroker";

const log = getLogger("BridgedClient");

// The length of time to wait before trying to join the channel again
const JOIN_TIMEOUT_MS = 15 * 1000; // 15s
const NICK_DELAY_TIMER_MS = 10 * 1000; // 10s

// All of these are not defined yet.
/* eslint-disable @typescript-eslint/no-explicit-any */
type IrcClient = EventEmitter|any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface GetNicksResponse {
    server: IrcServer;
    channel: string;
    nicks: string[];
    names: {[nick: string]: string};
}

interface GetNicksResponseOperators extends GetNicksResponse {
    operatorNicks: string[];
}

interface WhoisResponse {
    user: string;
    idle: number;
    channels: string[];
    host: string;
    realname: string;
}

export const illegalCharactersRegex = /[^A-Za-z0-9\]\[\^\\\{\}\-`_\|]/g;

export class BridgedClient extends EventEmitter {
    public readonly userId: string|null;
    public readonly displayName: string|null;
    private _nick: string;
    private readonly id: string;
    private readonly password?: string;
    private _unsafeClient: IrcClient|null = null;
    private lastActionTs: number;
    private inst: ConnectionInstance|null = null;
    private instCreationFailed = false;
    private _explicitDisconnect = false;
    private _disconnectReason: string|null = null;
    private _chanList: string[] = [];
    private connectDefer: promiseutil.Defer<void>;
    public readonly log: LoggerInstance;
    private cachedOperatorNicksInfo: {[channel: string]: GetNicksResponseOperators} = {};
    private idleTimeout: NodeJS.Timer|null = null;
    /**
     * Create a new bridged IRC client.
     * @constructor
     * @param {IrcServer} server
     * @param {IrcClientConfig} ircClientConfig : The IRC user to create a connection for.
     * @param {MatrixUser} matrixUser : Optional. The matrix user representing this virtual IRC user.
     * @param {boolean} isBot : True if this is the bot
     * @param {IrcEventBroker} eventBroker
     * @param {IdentGenerator} identGenerator
     * @param {Ipv6Generator} ipv6Generator
     */
    constructor(
        public readonly server: IrcServer,
        private clientConfig: IrcClientConfig,
        public readonly matrixUser: MatrixUser|undefined,
        public readonly isBot: boolean,
        private readonly eventBroker: IrcEventBroker,
        private readonly identGenerator: IdentGenerator,
        private readonly ipv6Generator: Ipv6Generator) {
        super();
        this.userId = matrixUser ? matrixUser.getId() : null;
        this.displayName = matrixUser ? matrixUser.getDisplayName() : null;

        // Set nick block
        const desiredNick = clientConfig.getDesiredNick();
        let chosenNick: string|null = null;
        if (desiredNick) {
            chosenNick = desiredNick;
        }
        else if (this.userId !== null) {
            chosenNick = server.getNick(this.userId, this.displayName || undefined);
        }
        else {
            throw Error("Could not determine nick for user");
        }
        this._nick = this.getValidNick(chosenNick, false);
        this.password = (
            clientConfig.getPassword() ? clientConfig.getPassword() : server.config.password
        );

        this.lastActionTs = Date.now();
        this.connectDefer = promiseutil.defer();
        this.id = (Math.random() * 1e20).toString(36);
        // decorate log lines with the nick and domain, along with an instance id
        let prefix = "<" + this.nick + "@" + this.server.domain + "#" + this.id + "> ";
        if (this.userId) {
            prefix += "(" + this.userId + ") ";
        }
        this.log = {
            // More args magic
            /* eslint-disable @typescript-eslint/no-explicit-any */
            debug: (...args: any[]) => {
                const msg = prefix + args[0];
                log.debug(msg, ...args.slice(1));
            },
            info: (...args: any[]) => {
                const msg = prefix + args[0];
                log.info(msg, ...args.slice(1));
            },
            error: (...args: any[]) => {
                const msg = prefix + args[0];
                log.error(msg, ...args.slice(1));
            }
            /* eslint-enable @typescript-eslint/no-explicit-any */
        } as unknown as LoggerInstance;
    }

    public get explicitDisconnect() {
        return this._explicitDisconnect;
    }

    public get disconnectReason() {
        return this._disconnectReason;
    }

    public get chanList() {
        return this._chanList;
    }

    public get unsafeClient() {
        return this._unsafeClient;
    }

    public get nick(): string {
        return this._nick;
    }


    public getClientConfig() {
        return this.clientConfig;
    }

    public kill(reason?: string) {
        // Nullify so that no further commands can be issued
        //  via unsafeClient, which should be null checked
        //  anyway as it is not instantiated until a connection
        //  has occurred.
        this._unsafeClient = null;
        // kill connection instance
        log.info('Killing client ', this.nick);
        return this.disconnect("killed", reason);
    }

    public isDead() {
        if (this.instCreationFailed || (this.inst && this.inst.dead)) {
            return true;
        }
        return false;
    }

    public toString() {
        const domain = this.server ? this.server.domain : "NO_DOMAIN";
        return `${this.nick}@${domain}#${this.id}~${this.userId}`;
    }

    /**
     * @return {ConnectionInstance} A new connected connection instance.
     */
    public async connect(): Promise<ConnectionInstance> {
        try {
            const nameInfo = await this.identGenerator.getIrcNames(
                this.clientConfig, this.matrixUser
            );
            const ipv6Prefix = this.server.getIpv6Prefix();
            if (ipv6Prefix) {
                // side-effects setting the IPv6 address on the client config
                await this.ipv6Generator.generate(
                    ipv6Prefix, this.clientConfig
                );
            }
            this.log.info(
                "Connecting to IRC server %s as %s (user=%s)",
                this.server.domain, this.nick, nameInfo.username
            );
            this.eventBroker.sendMetadata(this,
                `Connecting to the IRC network '${this.server.domain}' as ${this.nick}...`
            );

            const connInst = await ConnectionInstance.create(this.server, {
                nick: this.nick,
                username: nameInfo.username,
                realname: nameInfo.realname,
                password: this.password,
                // Don't use stored IPv6 addresses unless they have a prefix else they
                // won't be able to turn off IPv6!
                localAddress: (
                    this.server.getIpv6Prefix() ? this.clientConfig.getIpv6Address() : undefined
                )
            }, (inst: ConnectionInstance) => {
                this.onConnectionCreated(inst, nameInfo);
            });

            this.inst = connInst;
            this._unsafeClient = connInst.client;
            this.emit("client-connected", this);
            // we may have been assigned a different nick, so update it from source
            this._nick = connInst.client.nick;
            this.connectDefer.resolve();
            this.keepAlive();

            let connectText = (
                `You've been connected to the IRC network '${this.server.domain}' as ${this.nick}.`
            );

            const userModes = this.server.getUserModes();
            if (userModes.length > 0 && !this.isBot) {
                // These can fail, but the generic error listener will catch them and send them
                // into the same room as the connect text, so it's probably good enough to not
                // explicitly handle them.
                this.unsafeClient.setUserMode("+" + userModes);
                connectText += (
                    ` User modes +${userModes} have been set.`
                );
            }

            this.eventBroker.sendMetadata(this, connectText);

            connInst.client.addListener("nick", (old: string, newNick: string) => {
                if (old === this.nick) {
                    this.log.info(
                        "NICK: Nick changed from '" + old + "' to '" + newNick + "'."
                    );
                    this._nick = newNick;
                    this.emit("nick-change", this, old, newNick);
                }
            });
            connInst.client.addListener("error", (err: IrcMessage) => {
                // Errors we MUST notify the user about, regardless of the bridge's admin room config.
                const ERRORS_TO_FORCE = ["err_nononreg"]
                if (!err || !err.command || connInst.dead) {
                    return;
                }
                let msg = "Received an error on " + this.server.domain + ": " + err.command + "\n";
                msg += JSON.stringify(err.args);
                this.eventBroker.sendMetadata(this, msg, ERRORS_TO_FORCE.includes(err.command));
            });
            return connInst;
        }
        catch (err) {
            this.log.debug("Failed to connect.");
            this.instCreationFailed = true;
            throw err;
        }
    }

    public async reconnect() {
        await this.connect();
        this.log.info(
            "Reconnected %s@%s", this.nick, this.server.domain
        );
        this.log.info("Rejoining %s channels", this.chanList.length);
        await Promise.all(this.chanList.map((c: string) => {
            return this.joinChannel(c);
        }));
        this.log.info("Rejoined channels");
    }

    public disconnect(reason: InstanceDisconnectReason, textReason?: string) {
        this._explicitDisconnect = true;
        if (!this.inst || this.inst.dead) {
            return Promise.resolve();
        }
        return this.inst.disconnect(reason, textReason);
    }

    /**
     * Change this user's nick.
     * @param {string} newNick The new nick for the user.
     * @param {boolean} throwOnInvalid True to throw an error on invalid nicks
     * instead of coercing them.
     * @return {Promise<String>} Which resolves to a message to be sent to the user.
     */
    public changeNick(newNick: string, throwOnInvalid: boolean): Promise<string> {
        let validNick = newNick;
        try {
            validNick = this.getValidNick(newNick, throwOnInvalid);
            if (validNick === this.nick) {
                return Promise.resolve(`Your nick is already '${validNick}'.`);
            }
        }
        catch (err) {
            return Promise.reject(err);
        }
        if (!this.unsafeClient) {
            return Promise.reject(new Error("You are not connected to the network."));
        }

        return new Promise((resolve, reject) => {
            // These are nullified to prevent the linter from thinking these should be consts.
            let nickListener: ((old: string, n: string) => void) | null = null;
            let nickErrListener: ((err: IrcMessage) => void) | null = null;
            const timeoutId = setTimeout(() => {
                this.log.error("Timed out trying to change nick to %s", validNick);
                // may have d/ced between sending nick change and now so recheck
                if (this.unsafeClient) {
                    this.unsafeClient.removeListener("nick", nickListener);
                    this.unsafeClient.removeListener("error", nickErrListener);
                }
                reject(new Error("Timed out waiting for a response to change nick."));
            }, NICK_DELAY_TIMER_MS);
            nickListener = (old, n) => {
                clearTimeout(timeoutId);
                this.unsafeClient.removeListener("error", nickErrListener);
                resolve("Nick changed from '" + old + "' to '" + n + "'.");
            }
            nickErrListener = (err) => {
                if (!err || !err.command) { return; }
                const failCodes = [
                    "err_banonchan", "err_nickcollision", "err_nicknameinuse",
                    "err_erroneusnickname", "err_nonicknamegiven", "err_eventnickchange",
                    "err_nicktoofast", "err_unavailresource"
                ];
                if (failCodes.indexOf(err.command) !== -1) {
                    this.log.error("Nick change error : %s", err.command);
                    clearTimeout(timeoutId);
                    this.unsafeClient.removeListener("nick", nickListener);
                    reject(new Error("Failed to change nick: " + err.command));
                }
            }
            this.unsafeClient.once("nick", nickListener);
            this.unsafeClient.once("error", nickErrListener);
            this.unsafeClient.send("NICK", validNick);
        });
    }


    public leaveChannel(channel: string, reason = "User left") {
        if (!this.inst || this.inst.dead) {
            return Promise.resolve(); // we were never connected to the network.
        }
        if (channel.indexOf("#") !== 0) {
            return Promise.resolve(); // PM room
        }
        if (!this.inChannel(channel)) {
            return Promise.resolve(); // we were never joined to it.
        }
        const defer = promiseutil.defer();
        this.removeChannel(channel);
        this.log.debug("Leaving channel %s", channel);
        this.unsafeClient.part(channel, reason, () => {
            this.log.debug("Left channel %s", channel);
            defer.resolve();
        });

        return defer.promise;
    }

    public inChannel(channel: string) {
        return this.chanList.includes(channel);
    }

    public kick(nick: string, channel: string, reason: string) {
        reason = reason || "User kicked";
        if (!this.inst || this.inst.dead) {
            return Promise.resolve(); // we were never connected to the network.
        }
        if (Object.keys(this.unsafeClient.chans).indexOf(channel) === -1) {
            // we were never joined to it. We need to be joined to it to kick people.
            return Promise.resolve();
        }
        if (channel.indexOf("#") !== 0) {
            return Promise.resolve(); // PM room
        }

        return new Promise((resolve) => {
            this.log.debug("Kicking %s from channel %s", nick, channel);
            this.unsafeClient.send("KICK", channel, nick, reason);
            resolve(); // wait for some response? Is there even one?
        });
    }

    public sendAction(room: IrcRoom, action: IrcAction) {
        this.keepAlive();
        let expiryTs = 0;
        if (action.ts && this.server.getExpiryTimeSeconds()) {
            expiryTs = action.ts + (this.server.getExpiryTimeSeconds() * 1000);
        }
        switch (action.type) {
            case "message":
                return this.sendMessage(room, "message", action.text, expiryTs);
            case "notice":
                return this.sendMessage(room, "notice", action.text, expiryTs);
            case "emote":
                return this.sendMessage(room, "action", action.text, expiryTs);
            case "topic":
                return this.setTopic(room, action.text);
            default:
                this.log.error("Unknown action type: %s", action.type);
        }
        return Promise.reject(new Error("Unknown action type: " + action.type));
    }

    /**
     * Get the whois info for an IRC user
     * @param {string} nick : The nick to call /whois on
     */
    public whois(nick: string): Promise<{ server: IrcServer; nick: string; msg: string}> {
        return new Promise((resolve, reject) => {
            this.unsafeClient.whois(nick, (whois: WhoisResponse) => {
                if (!whois.user) {
                    reject(new Error("Cannot find nick on whois."));
                    return;
                }
                const idle = whois.idle ? `${whois.idle} seconds idle` : "";
                const chans = (
                    (whois.channels && whois.channels.length) > 0 ?
                    `On channels: ${JSON.stringify(whois.channels)}` :
                    ""
                );

                const info = `${whois.user}@${whois.host}
                Real name: ${whois.realname}
                ${chans}
                ${idle}
                `;
                resolve({
                    server: this.server,
                    nick: nick,
                    msg: `Whois info for '${nick}': ${info}`
                });
            });
        });
    }


    /**
     * Get the operators of a channel (including users more powerful than operators)
     * @param {string} channel : The channel to call /names on
     * @param {object} opts: Optional. An object containing the following key-value pairs:
     *     @param {string} key : Optional. The key to use to join the channel.
     *     @param {integer} cacheDurationMs : Optional. The duration of time to keep a
     *         list of operator nicks cached. If > 0, the operator nicks will be returned
     *         whilst the cache is still valid and it will become invalid after cacheDurationMs
     *         milliseconds. Cache will not be used if left undefined.
     */
    public async getOperators(channel: string, opts: {
        key?: string;
        cacheDurationMs?: number;
    } = {}): Promise<GetNicksResponseOperators> {
        const key = opts.key;
        const cacheDurationMs = opts.cacheDurationMs;

        if (key !== undefined && typeof key !== 'string') {
            throw new Error('key must be a string');
        }

        if (cacheDurationMs !== undefined) {
            if (!(Number.isInteger(cacheDurationMs) && cacheDurationMs > 0)) {
                throw new Error('cacheDurationMs must be a positive integer');
            }
            // If cached previously, use cache
            if (this.cachedOperatorNicksInfo[channel] !== undefined) {
                return Promise.resolve(this.cachedOperatorNicksInfo[channel]);
            }
        }
        await this.joinChannel(channel, key);
        const nicksInfo = await this.getNicks(channel);
        await this.leaveChannel(channel);
        const nicks = nicksInfo.nicks;
        // RFC 1459 1.3.1:
        // A channel operator is identified by the '@' symbol next to their
        // nickname whenever it is associated with a channel (ie replies to the
        // NAMES, WHO and WHOIS commands).

        // http://www.irc.org/tech_docs/005.html
        // ISUPPORT PREFIX:
        // A list of channel modes a person can get and the respective prefix a channel
        // or nickname will get in case the person has it. The order of the modes goes
        // from most powerful to least powerful. Those prefixes are shown in the output
        // of the WHOIS, WHO and NAMES command.
        // Note: Some servers only show the most powerful, others may show all of them.

        // Ergo: They are a chan op if they are "@" or "more powerful than @".
        const operatorNicks = nicks.filter((nick) => {
            for (let i = 0; i < nicksInfo.names[nick].length; i++) {
                const prefix = nicksInfo.names[nick][i];
                if (prefix === "@") {
                    return true;
                }
                const cli = this.unsafeClient;
                if (!cli) {
                    throw new Error("Missing client");
                }
                if (cli.isUserPrefixMorePowerfulThan(prefix, "@")) {
                    return true;
                }
            }
            return false;
        });

        const nicksInfoExtended = {
            ...nicksInfo,
            operatorNicks
        };

        if (typeof cacheDurationMs !== 'undefined') {
            this.cachedOperatorNicksInfo[channel] = nicksInfoExtended;
            setTimeout(()=>{
                //Invalidate the cache
                delete this.cachedOperatorNicksInfo[channel];
            }, cacheDurationMs);
        }

        return nicksInfoExtended;
    }

    /**
     * Get the nicks of the users in a channel
     * @param {string} channel : The channel to call /names on
     */
    public getNicks(channel: string): Bluebird<GetNicksResponse> {
        return new Bluebird((resolve) => {
            this.unsafeClient.names(channel, (channelName: string, names: {[nick: string]: string}) => {
                // names maps nicks to chan op status, where '@' indicates chan op
                // names = {'nick1' : '', 'nick2' : '@', ...}
                resolve({
                    server: this.server,
                    channel: channelName,
                    nicks: Object.keys(names),
                    names: names,
                });
            });
        }).timeout(5000) as Bluebird<GetNicksResponse>;
    }


    /**
     * Convert the given nick into a valid nick. This involves length and character
     * checks on the provided nick. If the client is connected to an IRCd then the
     * cmds received (e.g. NICKLEN) will be used in the calculations. If the client
     * is NOT connected to an IRCd then this function will NOT take length checks
     * into account. This means this function will optimistically allow long nicks
     * in the hopes that it will succeed, rather than use the RFC stated maximum of
     * 9 characters which is far too small. In testing, IRCds coerce long
     * nicks up to the limit rather than preventing the connection entirely.
     *
     * This function may modify the nick in interesting ways in order to coerce the
     * given nick into a valid nick. If throwOnInvalid is true, this function will
     * throw a human-readable error instead of coercing the nick on invalid nicks.
     *
     * @param {string} nick The nick to convert into a valid nick.
     * @param {boolean} throwOnInvalid True to throw an error on invalid nicks
     * instead of coercing them.
     * @return {string} A valid nick.
     * @throws Only if throwOnInvalid is true and the nick is not a valid nick.
     * The error message will contain a human-readable message which can be sent
     * back to a user.
     */
    private getValidNick(nick: string, throwOnInvalid: boolean): string {
        // Apply a series of transformations to the nick, and check after each
        // stage for mismatches to the input (and throw if appropriate).


        // strip illegal chars according to RFC 2812 Sect 2.3.1
        let n = nick.replace(illegalCharactersRegex, "");
        if (throwOnInvalid && n !== nick) {
            throw new Error(`Nick '${nick}' contains illegal characters.`);
        }

        // nicks must start with a letter
        if (!/^[A-Za-z]/.test(n)) {
            if (throwOnInvalid) {
                throw new Error(`Nick '${nick}' must start with a letter.`);
            }
            // Add arbitrary letter prefix. This is important for guest user
            // IDs which are all numbers.
            n = "M" + n;
        }

        if (this.unsafeClient) {
            // nicks can't be too long
            let maxNickLen = 9; // RFC 1459 default
            if (this.unsafeClient.supported &&
                    typeof this.unsafeClient.supported.nicklength == "number") {
                maxNickLen = this.unsafeClient.supported.nicklength;
            }
            if (n.length > maxNickLen) {
                if (throwOnInvalid) {
                    throw new Error(`Nick '${nick}' is too long. (Max: ${maxNickLen})`);
                }
                n = n.substr(0, maxNickLen);
            }
        }

        return n;
    }

    private keepAlive() {
        this.lastActionTs = Date.now();
        if (this.server.shouldSyncMembershipToIrc("initial") || 
            this.isBot) {
                // If we are mirroring matrix membership OR
                // we are a bot, do not disconnect.
            return;
        }
        const idleTimeout = this.server.getIdleTimeout();
        if (idleTimeout > 0) {
            if (this.idleTimeout) {
                // stop the timeout
                clearTimeout(this.idleTimeout);
            }
            this.log.debug(
                "_keepAlive; Restarting %ss idle timeout", idleTimeout
            );
            // restart the timeout
            this.idleTimeout = setTimeout(() => {
                this.log.info("Idle timeout has expired");
                this.disconnect(
                    "idle", `Idle timeout reached: ${idleTimeout}s`
                ).then(() => {
                    this.log.info("Idle timeout reached: Disconnected");
                }).catch((e) => {
                    this.log.error("Error when disconnecting: %s", JSON.stringify(e));
                });
            }, (1000 * idleTimeout));
        }
    }
    private removeChannel(channel: string) {
        const i = this.chanList.indexOf(channel);
        if (i === -1) {
            return;
        }
        this.chanList.splice(i, 1);
    }

    private addChannel(channel: string) {
        const i = this.chanList.indexOf(channel);
        if (i !== -1) {
            return; // already added
        }
        this.chanList.push(channel);
    }

    public getLastActionTs() {
        return this.lastActionTs;
    }

    private onConnectionCreated(connInst: ConnectionInstance, nameInfo: {username?: string}) {
        // listen for a connect event which is done when the TCP connection is
        // established and set ident info (this is different to the connect() callback
        // in node-irc which actually fires on a registered event..)
        connInst.client.once("connect", function() {
            let localPort = -1;
            if (connInst.client.conn && connInst.client.conn.localPort) {
                localPort = connInst.client.conn.localPort;
            }
            if (localPort > 0 && nameInfo.username) {
                Ident.setMapping(nameInfo.username, localPort);
            }
        });

        connInst.onDisconnect = (reason) => {
            this._disconnectReason = reason;
            if (reason === "banned") {
                // If we've been banned, this is intentional.
                this._explicitDisconnect = true;
            }
            this.emit("client-disconnected", this);
            this.eventBroker.sendMetadata(this,
                "Your connection to the IRC network '" + this.server.domain +
                "' has been lost. "
            );
            if (this.idleTimeout) {
                clearTimeout(this.idleTimeout);
            }
        }

        this.eventBroker.addHooks(this, connInst);
    }

    private async setTopic(room: IrcRoom, topic: string): Promise<void> {
        // join the room if we haven't already
        await this.joinChannel(room.channel)
        this.log.info("Setting topic to %s in channel %s", topic, room.channel);
        this.unsafeClient.send("TOPIC", room.channel, topic);
    }

    private async sendMessage(room: IrcRoom, msgType: string, text: string, expiryTs: number) {
        // join the room if we haven't already
        const defer = promiseutil.defer();
        msgType = msgType || "message";
        try {
            await this.connectDefer.promise;
            await this.joinChannel(room.channel);
            // re-check timestamp to see if we should send it now
            if (expiryTs && Date.now() > expiryTs) {
                this.log.error(`Dropping event: too old (expired at ${expiryTs})`);
                defer.resolve();
                return;
            }

            if (msgType == "action") {
                this.unsafeClient.action(room.channel, text);
            }
            else if (msgType == "notice") {
                this.unsafeClient.notice(room.channel, text);
            }
            else if (msgType == "message") {
                this.unsafeClient.say(room.channel, text);
            }
            defer.resolve();
        }
        catch (ex) {
            this.log.error("sendMessage: Failed to join channel " + room.channel);
            defer.reject(ex);
        }
        await defer.promise;
    }

    private joinChannel(channel: string, key?: string, attemptCount = 1): Bluebird<IrcRoom> {
        if (!this.unsafeClient) {
            // we may be trying to join before we've connected, so check and wait
            if (this.connectDefer && this.connectDefer.promise.isPending()) {
                return this.connectDefer.promise.then(() => {
                    return this.joinChannel(channel, key, attemptCount);
                });
            }
            return Bluebird.reject(new Error("No client"));
        }
        if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
            return Bluebird.resolve(new IrcRoom(this.server, channel));
        }
        if (channel.indexOf("#") !== 0) {
            // PM room
            return Bluebird.resolve(new IrcRoom(this.server, channel));
        }
        if (this.server.isExcludedChannel(channel)) {
            return Bluebird.reject(new Error(channel + " is a do-not-track channel."));
        }
        const defer = promiseutil.defer() as promiseutil.Defer<IrcRoom>;
        this.log.debug("Joining channel %s", channel);
        this.addChannel(channel);
        const client = this.unsafeClient;
        // listen for failures to join a channel (e.g. +i, +k)
        const failFn = (err: IrcMessage) => {
            if (!err || !err.args) { return; }
            const failCodes = [
                "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
                "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey",
                "err_needreggednick"
            ];
            this.log.error("Join channel %s : %s", channel, JSON.stringify(err));
            if (err.command && failCodes.includes(err.command) && err.args.includes(channel)) {
                this.log.error("Cannot track channel %s: %s", channel, err.command);
                client.removeListener("error", failFn);
                defer.reject(new Error(err.command));
                this.emit("join-error", this, channel, err.command);
                this.eventBroker.sendMetadata(
                    this, `Could not join ${channel} on '${this.server.domain}': ${err.command}`, true
                );
            }
        }
        client.once("error", failFn);

        // add a timeout to try joining again
        setTimeout(() => {
            if (!this.unsafeClient) {
                log.error(
                    `Could not try to join: no client for ${this.nick}, channel = ${channel}`
                );
                return;
            }
            // promise isn't resolved yet and we still want to join this channel
            if (defer.promise.isPending() && this.chanList.indexOf(channel) !== -1) {
                // we may have joined but didn't get the callback so check the client
                if (Object.keys(this.unsafeClient.chans).indexOf(channel) !== -1) {
                    // we're joined
                    this.log.debug("Timed out joining %s - didn't get callback but " +
                        "are now joined. Resolving.", channel);
                    defer.resolve(new IrcRoom(this.server, channel));
                    return;
                }
                if (attemptCount >= 5) {
                    defer.reject(
                        new Error("Failed to join " + channel + " after multiple tries")
                    );
                    return;
                }

                this.log.error("Timed out trying to join %s - trying again.", channel);
                // try joining again.
                attemptCount += 1;
                this.joinChannel(channel, key, attemptCount).then((s) => {
                    defer.resolve(s);
                }).catch((e: Error) => {
                    defer.reject(e);
                });
            }
        }, JOIN_TIMEOUT_MS);

        // send the JOIN with a key if it was specified.
        this.unsafeClient.join(channel + (key ? " " + key : ""), () => {
            this.log.debug("Joined channel %s", channel);
            client.removeListener("error", failFn);
            const room = new IrcRoom(this.server, channel);
            defer.resolve(room);
        });

        return defer.promise;
    }
}
