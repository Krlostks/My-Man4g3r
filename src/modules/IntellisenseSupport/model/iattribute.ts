export interface IAttribute {
    description?: string;
    name: string;
    /** El JSON trae "true"/"false" como string; el extractor lo normaliza a boolean. */
    required?: boolean | string;
    type?: string;
}
