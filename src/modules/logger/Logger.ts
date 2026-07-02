import * as vscode from 'vscode';
import { LogWebviewProvider } from './LogWebviewProvider';

export type LogCategory = 'SERVER' | 'MAVEN' | 'WATCHER' | 'CACHE' | 'HOTRELOAD' | 'GENERAL' | 'VERSION_CONTROL' | 'GIT' | 'DATABASE' | 'AI' | 'DEBUG' | 'XHTML' | 'SERVER_LOGS';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const CATEGORY_ICONS: Record<LogCategory, string> = {
    SERVER: '',
    MAVEN: '',
    WATCHER: '',
    CACHE: '',
    HOTRELOAD: '',
    GENERAL: '',
    VERSION_CONTROL: '',
    GIT: '',
    DATABASE: '',
    AI: '',
    DEBUG: '',
    XHTML: '',
    SERVER_LOGS: '',
};

export class Logger {

    private static channel: vscode.OutputChannel;
    private static serverChannel: vscode.OutputChannel;
    private static webview: LogWebviewProvider | undefined;

    static init(context: vscode.ExtensionContext): void {
        Logger.channel = vscode.window.createOutputChannel('mm43');
        Logger.serverChannel = vscode.window.createOutputChannel('mm43-server');
        context.subscriptions.push(Logger.channel);
        context.subscriptions.push(Logger.serverChannel);
    }

    static setWebview(provider: LogWebviewProvider): void {
        Logger.webview = provider;
    }

    static info(category: LogCategory, msg: string): void {
        Logger.log('INFO', category, msg);
    }

    static warn(category: LogCategory, msg: string): void {
        Logger.log('WARN', category, msg);
    }

    static error(category: LogCategory, msg: string): void {
        Logger.log('ERROR', category, msg);
    }

    static debug(category: LogCategory, msg: string): void {
        Logger.log('DEBUG', category, msg);
    }

    static section(title: string): void {
        const line = `━━━ ${title} ━━━`;
        Logger.channel.appendLine('');
        Logger.channel.appendLine(line);
        Logger.webview?.addEntry('INFO', 'GENERAL', line);
    }

    static raw(text: string): void {
        const clean = Logger.sanitize(text);
        if (!clean.trim()) { return; }
        Logger.channel.append(clean);
    }

    static show(): void {
        Logger.channel.show(true);
    }

    static showServerLogs(): void {
        Logger.serverChannel.show(true);
    }

    static getChannel(): vscode.OutputChannel {
        return Logger.channel;
    }

    static getServerChannel(): vscode.OutputChannel {
        return Logger.serverChannel;
    }

    private static log(level: LogLevel, category: LogCategory, msg: string): void {
        const clean = Logger.sanitize(msg);
        
        // Los logs del servidor van al canal específico para servidor
        if (category === 'SERVER') {
            Logger.serverChannel.appendLine(clean);
        }
        
        // Todos los demás logs van al webview
        Logger.webview?.addEntry(level, category, clean);
    }

    private static timestamp(): string {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    static sanitize(text: string): string {
        let s = text;
        s = s.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}\]\s*/g, '');
        s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}\s*/g, '');
        s = s.replace(/\x1b\[[0-9;]*m/g, '');
        s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
        s = s.replace(/(\r?\n){3,}/g, '\n\n');
        return s;
    }
}
