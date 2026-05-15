/**
 * MM43 - Motor de Aplanamiento Cronológico Semántico
 * VersionVectorEngine.ts - Lógica de comparación y gestión de Vectores de Versión
 */

import { VersionVector, CausalRelation, CommitMetadata } from '../../config/types';

export class VersionVectorEngine {

    /**
     * Compara dos vectores de versión y devuelve su relación causal.
     *
     * Reglas:
     *   A <= B  si para todo d: A[d] <= B[d]
     *   A == B  si A <= B && B <= A
     *   A < B   si A <= B && A != B
     *   A || B  (concurrentes) si ni A <= B ni B <= A
     */
    static compare(a: VersionVector, b: VersionVector): CausalRelation {
        const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

        let aLeB = true;
        let bLeA = true;

        for (const key of allKeys) {
            const av = a[key] ?? 0;
            const bv = b[key] ?? 0;
            if (av > bv) { aLeB = false; }
            if (bv > av) { bLeA = false; }
        }

        if (aLeB && bLeA) { return 'EQUAL'; }
        if (aLeB) { return 'BEFORE'; }
        if (bLeA) { return 'AFTER'; }
        return 'CONCURRENT';
    }

    /**
     * Fusiona (merge) dos vectores tomando el máximo de cada componente.
     * Usado al integrar cambios de otro desarrollador.
     */
    static merge(a: VersionVector, b: VersionVector): VersionVector {
        const result: VersionVector = { ...a };
        for (const key of Object.keys(b)) {
            result[key] = Math.max(result[key] ?? 0, b[key]);
        }
        return result;
    }

    /**
     * Incrementa el contador del desarrollador local y fusiona con el vector recibido.
     * Debe llamarse al crear un nuevo commit.
     */
    static increment(current: VersionVector, developerId: string): VersionVector {
        const next = { ...current };
        next[developerId] = (next[developerId] ?? 0) + 1;
        return next;
    }

    /**
     * Serializa un CommitMetadata al formato de trailer de Git.
     * Formato: MM43-VV: {"dev1":3,"dev2":1}|featureId|developerId|timestamp
     */
    static serialize(metadata: CommitMetadata): string {
        const vvStr = JSON.stringify(metadata.versionVector);
        const parts = [
            vvStr,
            metadata.featureId ?? '',
            metadata.developerId,
            metadata.timestamp.toString()
        ];
        return `MM43-VV: ${parts.join('|')}`;
    }

    /**
     * Deserializa el trailer MM43-VV: ... de un mensaje de commit.
     * Retorna undefined si el commit no tiene metadatos MM43.
     */
    static deserialize(commitMessage: string): CommitMetadata | undefined {
        const match = commitMessage.match(/MM43-VV:\s*(.+)/);
        if (!match) { return undefined; }

        try {
            const parts = match[1].split('|');
            if (parts.length < 4) { return undefined; }

            const [vvStr, featureId, developerId, timestampStr] = parts;
            return {
                versionVector: JSON.parse(vvStr),
                featureId: featureId || undefined,
                developerId,
                timestamp: parseInt(timestampStr, 10)
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Construye un vector de versión vacío (para nuevos desarrolladores).
     */
    static empty(): VersionVector {
        return {};
    }

    /**
     * Determina si dos vectores concurrentes tienen riesgo de conflicto semántico
     * (heurística: comparten archivos modificados).
     */
    static isConcurrent(a: VersionVector, b: VersionVector): boolean {
        return this.compare(a, b) === 'CONCURRENT';
    }
}
