import * as PIXI from "pixi.js";

import {Board} from "./board";
import {Side, SideUtil} from "./side";
import {GamePhase} from "../phase/gamePhase";
import {GamePlayer} from "./gamePlayer";
import {CardTile} from "./cardTile";
import {SideTypeUtil} from "./card";
import {channel} from "../index";
import {PlayerPlacePawn} from "../protocol/game";

export class PawnPlacer extends PIXI.Container {
    phase: GamePhase;

    sideOverlay: PIXI.Graphics[] = [];
    monasteryOverlay?: PIXI.Graphics;

    constructor(phase: GamePhase) {
        super();
        this.phase = phase;

        this.initPixi();
    }

    createTriangle(points: PIXI.Point[], color: number, alpha: number, interactive: boolean): PIXI.Graphics {
        const g = new PIXI.Graphics();
        g.beginFill(color);
        g.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length; i++) {
            const point = points[(i + 1) % 3];
            g.lineTo(point.x, point.y);
        }
        g.endFill();
        g.alpha = 0.3;
        if (interactive) {
            g.hitArea = new PIXI.Polygon(points);
            g.interactive = interactive;
        }
        return g;
    }

    createSidePlacer(side: Side, size: number, color: number, alpha: number): PIXI.Graphics {
        const middle = size / 2;
        let points: PIXI.Point[];
        switch (side) {
            case Side.TOP:
                points = [new PIXI.Point(0, 0), new PIXI.Point(middle, middle), new PIXI.Point(size, 0)];
                break;
            case Side.BOTTOM:
                points = [new PIXI.Point(0, size), new PIXI.Point(middle, middle), new PIXI.Point(size, size)];
                break;
            case Side.LEFT:
                points = [new PIXI.Point(0, 0), new PIXI.Point(middle, middle), new PIXI.Point(0, size)];
                break;
            case Side.RIGHT:
                points = [new PIXI.Point(size, 0), new PIXI.Point(middle, middle), new PIXI.Point(size, size)];
                break;
        }
        const g = this.createTriangle(points, color, alpha, true);
        g.on("mouseover", () => g.alpha = Math.min(1, alpha + 0.2));
        g.on("mouseout", () => g.alpha = alpha);

        (g as any).getEmplacement = () => {
            const res = new PIXI.Point();
            for (let i = 0; i < 3; i++) {
                res.x += points[i].x;
                res.y += points[i].y;
            }
            res.x /= 3;
            res.y /= 3;
            res.x += this.position.x - size / 2;
            res.y += this.position.y - size / 2;

            console.log("Side emplacement", this.position);
            return res;
        };

        return g;
    }

    createPennantPlacer(size: number, color: number, alpha: number): PIXI.Graphics {
        const x = size / 2;
        const y = size / 2;
        const r = size / 3;

        const g = new PIXI.Graphics();
        g.beginFill(color);
        g.drawCircle(x, y, r);
        g.endFill();
        g.alpha = alpha;
        g.interactive = true;
        g.hitArea = new PIXI.Circle(x, y, r);

        g.on("mouseover", () => g.alpha = Math.min(1, alpha + 0.2));
        g.on("mouseout", () => g.alpha = alpha);

        (g as any).getEmplacement = () => {
            console.log("Pennant emplacement", this.position);
            return this.position;
        };

        return g;
    }

    initPixi() {
        const alpha = 0.5;

        // Side
        for (let side = 0; side < 4; side++) {
            this.sideOverlay[side] = this.createSidePlacer(
                side,
                Board.TILE_SIZE,
                [
                    0xff0000, // red
                    0x00ff00, // green
                    0x0000ff, // blue
                    0xffff00, // yellow
                ][side],
                alpha
            );
            this.sideOverlay[side].zIndex = 0;
            this.addChild(this.sideOverlay[side]);
        }

        // Monastery
        this.monasteryOverlay = this.createPennantPlacer(
            Board.TILE_SIZE,
            0xffffff, // white
            alpha
        );
        this.monasteryOverlay.zIndex = 1;
        this.monasteryOverlay.interactiveChildren = false;
        this.addChild(this.monasteryOverlay);

        this.pivot.set(Board.TILE_SIZE / 2, Board.TILE_SIZE / 2);
    }

    serveTo(placedCard: {x: number, y: number, tile: CardTile}, player: GamePlayer) {
        this.phase.board.cardCoordToRelPos(placedCard.x, placedCard.y, this.position);

        // Side
        let connector = this.phase.board.cardConnector;
        for (let side = 0; side < 4; side++) {
            this.removeChild(this.sideOverlay[side]);

            if (connector.canOwnPath(placedCard.x, placedCard.y, side)) {
                this.addChild(this.sideOverlay[side]);
                this.sideOverlay[side]
                    .off("pointerdown")
                    .on("pointerdown", () => {
                        this.placeSide(player, placedCard, (this.sideOverlay[side] as any).getEmplacement(), side);
                    });
            }
        }

        // Monastery
        this.removeChild(this.monasteryOverlay);
        if (placedCard.tile.card.flags.indexOf("monastery") >= 0) {
            this.addChild(this.monasteryOverlay);
            this.monasteryOverlay
                .off("pointerdown")
                .on("pointerdown", () => {
                    this.placeMonastery(player, placedCard, (this.monasteryOverlay as any).getEmplacement());
                });
        }
    }

    placeSide(player: GamePlayer, card: {x: number, y: number, tile: CardTile}, pos: PIXI.Point, side: Side) {
        let conn = this.phase.board.cardConnector;
        this.sendPacket(side, pos);
        conn.ownPath(card.x, card.y, player.id, side);
        this.phase.onPawnPlace(pos, conn.getPathData(card.x, card.y, side));
    }

    placeMonastery(player: GamePlayer, card: {x: number, y: number, tile: CardTile}, pos: PIXI.Point) {
        let monastery = card.tile.monasteryData!;
        this.sendPacket("monastery", pos);
        monastery.owner = player.id; // TODO check if ok
        this.phase.onPawnPlace(pos, monastery);
    }

    private sendPacket(side: Side | "monastery", pos?: PIXI.IPoint) {
        if (!this.phase.isMyRound()) return;
        channel.send({
            type: "player_place_pawn",
            side: side,
            pos: { x: pos.x, y: pos.y },
        } as PlayerPlacePawn);
    }
}

export interface PawnOwner {
    addPawn(g: PIXI.Container): void;
}