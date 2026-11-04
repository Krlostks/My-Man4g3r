import { ProjectConfig } from '../../config/types';
import { Logger } from '../logger/Logger';
import { MavenManager } from '../maven/MavenManager';
import { ServerManager } from './ServerManager';

export interface RedeployResult {
    success: boolean;
    serverState: string;
    deploymentState: 'completed' | 'failed' | 'not-run';
    message: string;
}

/** Orquesta un redeploy completo y no expone estados optimistas al hot reload. */
export class RedeployService {
    private redeployChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly serverManager: ServerManager,
        private readonly mavenManager: MavenManager,
    ) { }

    async redeploy(
        project: ProjectConfig,
        build?: () => Promise<boolean>,
    ): Promise<RedeployResult> {
        let result!: RedeployResult;
        const run = async (): Promise<void> => {
            Logger.info('SERVER', `Iniciando build y redeploy para ${project.name}.`);
            const buildStep = build ?? (() => this.mavenManager.buildExploded(project));
            const buildSuccess = await buildStep();
            const success = buildSuccess
                && await this.serverManager.fastRedeployAndWait(project);

            result = {
                success,
                serverState: this.serverManager.getServerState(),
                deploymentState: success ? 'completed' : 'failed',
                message: success
                    ? `Redeploy completado para ${project.name}.`
                    : `Redeploy falló para ${project.name}.`,
            };
            Logger.info('SERVER', result.message);
        };

        const queued = this.redeployChain.then(run, run);
        this.redeployChain = queued.then(() => undefined, () => undefined);
        await queued;
        return result;
    }
}
