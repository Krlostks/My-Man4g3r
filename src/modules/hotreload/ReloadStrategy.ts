import { ConfigManager } from '../../config/ConfigManager';
import { HotReloadClient, HotReloadResult } from './HotReloadClient';

export type ReloadChangeType = 'method-body' | 'structural';

export type ReloadStatus =
    | 'SUCCESS'
    | 'DISABLED'
    | 'UNSUPPORTED_STRUCTURAL_CHANGE'
    | 'AGENT_UNAVAILABLE'
    | 'RELOAD_FAILED';

export interface ReloadResult {
    success: boolean;
    status: ReloadStatus;
    message: string;
    reloadType: ReloadChangeType;
    requiresRedeploy: boolean;
}

export interface ReloadStrategy {
    readonly name: string;
    supports(changeType: ReloadChangeType): boolean;
    reload(className: string, classFilePath: string, changeType: ReloadChangeType): Promise<ReloadResult>;
}

abstract class AgentReloadStrategy implements ReloadStrategy {
    abstract readonly name: string;

    abstract supports(changeType: ReloadChangeType): boolean;

    async reload(className: string, classFilePath: string, changeType: ReloadChangeType): Promise<ReloadResult> {
        if (!this.supports(changeType)) {
            return {
                success: false,
                status: 'UNSUPPORTED_STRUCTURAL_CHANGE',
                message: 'La estrategia de recarga activa no soporta este cambio estructural.',
                reloadType: changeType,
                requiresRedeploy: true,
            };
        }

        const result: HotReloadResult = await HotReloadClient.sendReloadResult(className, classFilePath);
        return {
            success: result.success,
            status: result.status === 'AGENT_UNAVAILABLE' ? 'AGENT_UNAVAILABLE' : result.success ? 'SUCCESS' : 'RELOAD_FAILED',
            message: result.message,
            reloadType: changeType,
            requiresRedeploy: false,
        };
    }
}

export class StandardJvmReloadStrategy extends AgentReloadStrategy {
    readonly name = 'JVM estándar';

    supports(changeType: ReloadChangeType): boolean {
        return changeType === 'method-body';
    }
}

export class DcevmReloadStrategy extends AgentReloadStrategy {
    readonly name = 'DCEVM';

    supports(_changeType: ReloadChangeType): boolean {
        return true;
    }

    async reload(className: string, classFilePath: string, changeType: ReloadChangeType): Promise<ReloadResult> {
        const result = await super.reload(className, classFilePath, changeType);
        if (!result.success && changeType === 'structural') {
            result.requiresRedeploy = true;
        }
        return result;
    }
}

export class NoopReloadStrategy implements ReloadStrategy {
    readonly name = 'Sin recarga';

    supports(_changeType: ReloadChangeType): boolean {
        return false;
    }

    async reload(_className: string, _classFilePath: string, changeType: ReloadChangeType): Promise<ReloadResult> {
        return {
            success: true,
            status: 'DISABLED',
            message: 'La recarga está deshabilitada.',
            reloadType: changeType,
            requiresRedeploy: false,
        };
    }
}

export function createReloadStrategy(): ReloadStrategy {
    const mode = ConfigManager.getAgentMode();
    switch (mode) {
        case 'dcevm':
            return new DcevmReloadStrategy();
        case 'basic':
        case 'standard':
            return new StandardJvmReloadStrategy();
        case 'none':
        default:
            return new NoopReloadStrategy();
    }
}
