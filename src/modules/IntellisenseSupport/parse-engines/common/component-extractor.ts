import { ComponentDefinition } from "../../common";
import { Component, IComponent } from "../../model";

export default class ComponentExtractor {
    /**
     * Convierte el nodo `components.component` del JSON en definiciones.
     * Acepta arreglo u objeto único, y normaliza `attribute` (arreglo/objeto) y `required` ("true"/true).
     */
    public static extract(raw: IComponent[] | IComponent | undefined | null): ComponentDefinition[] {
        if (!raw) {
            return [];
        }
        const list = Array.isArray(raw) ? raw : [raw];
        return list.map((jsonComp) => {
            const component = new Component(jsonComp.description ?? "", jsonComp.name ?? "");
            const attrs = jsonComp.attribute
                ? (Array.isArray(jsonComp.attribute) ? jsonComp.attribute : [jsonComp.attribute])
                : [];
            for (const attr of attrs) {
                component.addAtribute(
                    attr.description ?? "",
                    attr.name ?? "",
                    attr.required === true || attr.required === "true",
                    attr.type ?? ""
                );
            }
            return new ComponentDefinition(component);
        });
    }
}
