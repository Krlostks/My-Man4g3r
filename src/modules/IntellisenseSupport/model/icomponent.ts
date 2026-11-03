import { IAttribute } from "./iattribute";

export interface IComponent {
    description?: string;
    name: string;
    /** Según el JSON puede venir como arreglo o como objeto único. */
    attribute?: IAttribute[] | IAttribute;
}
