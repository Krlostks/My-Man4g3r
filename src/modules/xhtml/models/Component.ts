import { Attribute } from "./Attribute";


export class Component {
    public descripcion: string = "";
    public nombre: string = "";
    public atributos: Attribute[] = [];

    constructor(descripcion: string, nombre: string) {
        this.descripcion = descripcion;
        this.nombre = nombre;
    }

    agregarAtributo(description: string, name: string, required: boolean, type: string): void {
        this.atributos.push(new Attribute(description, name, required, type));
    }
}