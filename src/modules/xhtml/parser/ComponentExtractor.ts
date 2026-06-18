import * as fs from "node:fs"
import * as vscode from "vscode"
import * as path from 'path';
import {Component} from "../models/Component";
import {Attribute} from "../models/Attribute";
import {ComponentDefinition} from "../models/ComponentDefinition";

export interface componenteJson{
    name:string;
    description:string;
    attribute?:Attribute[] | atributoJson[] | atributoJson;  // JSON real usa "attribute"
}

export interface atributoJson{
    name: string;
    description : string;
    required : boolean | string;
    type: string;
}
export class ComponentExtractor{
    static extraer(textoJson: string): ComponentDefinition[]{
        const componentesJson = JSON.parse(textoJson) as componenteJson[];
        const definiciones: ComponentDefinition[] = [];

        componentesJson.forEach((componenteJson) => {
            const componente = new Component(componenteJson.description, componenteJson.name)

            if (componenteJson.attribute) {
                const atributos = Array.isArray(componenteJson.attribute) ? componenteJson.attribute : [componenteJson.attribute];
                
                atributos.forEach((attr) => {
                    const requerido = attr.required === true || attr.required === "true";
                    componente.agregarAtributo(
                        attr.description || "",
                        attr.name || "",
                        requerido,
                        attr.type || ""
                    )
                });
            }
            definiciones.push(new ComponentDefinition(componente));
        });
        return definiciones;
    }

    
    static cargarDeArchivo(extensionRuta: string, dataruta: string): ComponentDefinition[]{
        const jsonRuta = path.join(extensionRuta, 'src', 'modules', 'xhtml', 'data', `${dataruta}.json`)
        const contenidoJson = fs.readFileSync(jsonRuta, 'utf-8');
        const datos = JSON.parse(contenidoJson);
        // Los JSONs PrimeFaces/OmniFaces tienen estructura: { components: { component: [...] } }
        const componentes = datos.components?.component || datos;
        
        return ComponentExtractor.extraer(JSON.stringify(componentes));
    }
}
