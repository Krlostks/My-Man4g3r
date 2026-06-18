import * as vscode from "vscode";
import { Component } from "./Component";


export class ComponentDefinition{
    constructor(
        public componente: Component,
        public locacion?: vscode.Location
    ){
    }
}