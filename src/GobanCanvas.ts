/*
 * Copyright 2012-2019 Online-Go.com
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import { JGOF } from './JGOF';
import { AdHocFormat } from './AdHocFormat';

import {
    GobanCore,
    GobanConfig,
    GobanSelectedThemes,
    GOBAN_FONT,
    SCORE_ESTIMATION_TRIALS,
    SCORE_ESTIMATION_TOLERANCE,
    AUTOSCORE_TRIALS,
    AUTOSCORE_TOLERANCE,
    MARK_TYPES,
} from './GobanCore';
import {GoEngine, encodeMove, encodeMoves} from "./GoEngine";
import {GoMath} from "./GoMath";
import {MoveTree} from "./MoveTree";
import {GoThemes} from "./GoThemes";
import { MoveTreePenMarks } from "./MoveTree";
import {createDeviceScaledCanvas, resizeDeviceScaledCanvas, deviceCanvasScalingRatio, elementOffset} from "./GoUtil";
import { getRelativeEventPosition, getRandomInt } from "./GoUtil";
import {_, pgettext, interpolate} from "./translate";

let __theme_cache = {"black": {}, "white": {}};
declare var ResizeObserver;

export interface GobanCanvasConfig extends GobanConfig {
    board_div: HTMLElement;
}

interface ViewPortInterface {
    offset_x: number;
    offset_y: number;
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
}

export class GobanCanvas extends GobanCore  {
    private parent: HTMLElement;
    private board_div: HTMLElement;
    private board: HTMLCanvasElement;
    private __set_board_height;
    private __set_board_width;
    private ready_to_draw:boolean = false;
    private message_div:HTMLDivElement;
    private message_td:HTMLElement;
    private message_text:HTMLDivElement;
    private message_timeout:number;
    private shadow_layer:HTMLCanvasElement;
    private shadow_ctx:CanvasRenderingContext2D;
    private handleShiftKey:(ev:KeyboardEvent) => void;

    public move_tree_container: HTMLElement;
    private move_tree_inner_container: HTMLDivElement;
    private move_tree_canvas: HTMLCanvasElement;



    constructor(config:GobanCanvasConfig, preloaded_data?:AdHocFormat|JGOF) {
        super(config, preloaded_data);

        this.parent = config["board_div"];
        if (!this.parent) {
            this.no_display = true;
            this.parent = document.createElement("div"); /* let a div dangle in no-mans land to prevent null pointer refs */
        }

        this.board = createDeviceScaledCanvas(10, 10);
        this.board.setAttribute("id", "board-canvas");
        this.board.className = "StoneLayer";
        this.parent.append(this.board);
        this.bindPointerBindings(this.board);

        this.move_tree_container = config["move_tree_container"];

        this.handleShiftKey = (ev) => {
            if (ev.shiftKey !== this.shift_key_is_down) {
                this.shift_key_is_down = ev.shiftKey;
                if (this.last_hover_square) {
                    this.__drawSquare(this.last_hover_square.x, this.last_hover_square.y);
                }
            }
        };
        window.addEventListener("keydown", this.handleShiftKey);
        window.addEventListener("keyup", this.handleShiftKey);

        this.post_config_constructor();

        this.ready_to_draw = true;
        this.redraw(true);
    }
    public enablePen():void {
        this.attachPenCanvas();
    }
    public disablePen():void {
        this.detachPenCanvas();
    }

    public destroy():void {
        super.destroy();

        this.board.remove();
        this.detachPenCanvas();
        this.detachShadowLayer();

        if (this.message_timeout) {
            clearTimeout(this.message_timeout);
            this.message_timeout = null;
        }

        window.removeEventListener("keydown", this.handleShiftKey);
        window.removeEventListener("keyup", this.handleShiftKey);
    }
    private detachShadowLayer():void {
        if (this.shadow_layer) {
            this.shadow_layer.remove();
            this.shadow_layer = null;
            this.shadow_ctx = null;
        }
    }
    private attachShadowLayer():void {
        if (!this.shadow_layer && this.parent) {
            this.shadow_layer = createDeviceScaledCanvas(this.metrics.width, this.metrics.height);
            this.shadow_layer.setAttribute("id", "shadow-canvas");
            this.shadow_layer.className = "ShadowLayer";

            this.parent.insertBefore(this.shadow_layer, this.board);
            //this.shadow_layer.css({"left": this.layer_offset_left, "top": this.layer_offset_top});
            this.shadow_layer.style.left = this.layer_offset_left;
            this.shadow_layer.style.top = this.layer_offset_top;


            this.shadow_ctx = this.shadow_layer.getContext("2d");
            this.bindPointerBindings(this.shadow_layer);
        }
    }
    private detachPenCanvas():void {
        if (this.pen_layer) {
            this.pen_layer.remove();
            this.pen_layer = null;
            this.pen_ctx = null;
        }
    }
    private attachPenCanvas():void {
        if (!this.pen_layer) {
            this.pen_layer = createDeviceScaledCanvas(this.metrics.width, this.metrics.height);
            this.pen_layer.setAttribute("id", "pen-canvas");
            this.pen_layer.className = "PenLayer";
            this.parent.append(this.pen_layer);
            //this.pen_layer.css({"left": this.layer_offset_left, "top": this.layer_offset_top});
            this.pen_layer.style.left = this.layer_offset_left;
            this.pen_layer.style.top = this.layer_offset_top;
            this.pen_ctx = this.pen_layer.getContext("2d");
            this.bindPointerBindings(this.pen_layer);
        }
    }
    private bindPointerBindings(canvas:HTMLCanvasElement):void {
        if (!this.interactive) {
            return;
        }

        if (canvas.getAttribute("data-pointers-bound") === "true") {
            return;
        }

        canvas.setAttribute("data-pointers-bound", "true");


        let dragging = false;

        let last_click_square = this.xy2ij(0, 0);

        let pointerUp = (ev, double_clicked) => {
            if (!dragging) {
                /* if we didn't start the click in the canvas, don't respond to it */
                return;
            }

            dragging = false;

            if (this.scoring_mode) {
                let pos = getRelativeEventPosition(ev);
                let pt = this.xy2ij(pos.x, pos.y);
                if (pt.i >= 0 && pt.i < this.width && pt.j >= 0 && pt.j < this.height) {
                    if (this.score_estimate) {
                        this.score_estimate.handleClick(pt.i, pt.j, ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey);
                    }
                    this.emit("update");
                }
                return;
            }

            if (ev.ctrlKey || ev.metaKey || ev.altKey) {
                try {
                    let pos = getRelativeEventPosition(ev);
                    let pt = this.xy2ij(pos.x, pos.y);
                    if (GobanCore.hooks.addCoordinatesToChatInput) {
                        GobanCore.hooks.addCoordinatesToChatInput(this.engine.prettyCoords(pt.i, pt.j));
                    }
                } catch (e) {
                    console.error(e);
                }
                return;
            }

            if (this.mode === "analyze" && this.analyze_tool === "draw") {
                /* might want to interpret this as a start/stop of a line segment */
            } else {
                let pos = getRelativeEventPosition(ev);
                let pt = this.xy2ij(pos.x, pos.y);
                if (!double_clicked) {
                    last_click_square = pt;
                } else {
                    if (last_click_square.i !== pt.i || last_click_square.j !== pt.j) {
                        this.onMouseOut(ev);
                        return;
                    }
                }

                this.onTap(ev, double_clicked);
                this.onMouseOut(ev);
            }
        };

        let pointerDown = (ev) => {
            dragging = true;
            if (this.mode === "analyze" && this.analyze_tool === "draw") {
                this.onPenStart(ev);
            }
            else if (this.mode === "analyze" && this.analyze_tool === "label") {
                if (ev.shiftKey) {
                    if (this.analyze_subtool === "letters") {
                        let label_char = prompt(_("Enter the label you want to add to the board"), "");
                        if (label_char) {
                            this.label_character = label_char.substring(0, 3);
                            dragging = false;
                            return;
                        }
                    }
                }

                this.onLabelingStart(ev);
            }
        };

        let pointerMove = (ev) => {
            if (this.mode === "analyze" && this.analyze_tool === "draw") {
                if (!dragging) { return; }
                this.onPenMove(ev);
            } else if (dragging && this.mode === "analyze" && this.analyze_tool === "label") {
                this.onLabelingMove(ev);
            } else {
                 this.onMouseMove(ev);
            }
        };

        let pointerOut = (ev) => {
            dragging = false;
            this.onMouseOut(ev);
        };

        let mousedisabled:any = 0;

        canvas.addEventListener("click", (ev) => { if (!mousedisabled) { dragging = true; pointerUp(ev, false); } ev.preventDefault(); return false; });
        canvas.addEventListener("dblclick", (ev) => { if (!mousedisabled) { dragging = true; pointerUp(ev, true); } ev.preventDefault(); return false; });
        canvas.addEventListener("mousedown", (ev) => { if (!mousedisabled) { pointerDown(ev); } ev.preventDefault(); return false; });
        canvas.addEventListener("mousemove", (ev) => { if (!mousedisabled) { pointerMove(ev); } ev.preventDefault(); return false; });
        canvas.addEventListener("mouseout", (ev) => { if (!mousedisabled) { pointerOut(ev); } else { ev.preventDefault(); } return false; });
        canvas.addEventListener("focus", (ev) => { ev.preventDefault(); return false; });


        let lastX = 0;
        let lastY = 0;
        let startX = 0;
        let startY = 0;

        const onTouchStart = (ev:TouchEvent) => {
            if (mousedisabled) {
                clearTimeout(mousedisabled);
            }
            mousedisabled = setTimeout(() => { mousedisabled = 0; }, 5000);

            if (ev.target === canvas) {
                lastX = ev.touches[0].pageX;
                lastY = ev.touches[0].pageY;
                startX = ev.touches[0].pageX;
                startY = ev.touches[0].pageY;
                pointerDown(ev);
            } else if (dragging) {
                pointerOut(ev);
            }
        };
        const onTouchEnd = (ev:TouchEvent) => {
            if (mousedisabled) {
                clearTimeout(mousedisabled);
            }
            mousedisabled = setTimeout(() => { mousedisabled = 0; }, 5000);

            if (ev.target === canvas) {
                if (Math.sqrt((startX - lastX) * (startX - lastX) + (startY - lastY) * (startY - lastY)) > 10) {
                    pointerOut(ev);
                } else {
                    pointerUp(ev, false);
                }
            } else if (dragging) {
                pointerOut(ev);
            }
        };
        const onTouchMove = (ev:TouchEvent) => {
            if (mousedisabled) {
                clearTimeout(mousedisabled);
            }
            mousedisabled = setTimeout(() => { mousedisabled = 0; }, 5000);

            if (ev.target === canvas) {
                lastX = ev.touches[0].pageX;
                lastY = ev.touches[0].pageY;
                if (this.mode === "analyze" && this.analyze_tool === "draw") {
                    pointerMove(ev);
                    ev.preventDefault();
                    return false;
                }
            } else if (dragging) {
                pointerOut(ev);
            }
        };

        document.addEventListener("touchstart", onTouchStart);
        document.addEventListener("touchend", onTouchEnd);
        document.addEventListener("touchmove", onTouchMove);
        this.on("destroy", () => {
            document.removeEventListener("touchstart", onTouchStart);
            document.removeEventListener("touchend", onTouchEnd);
            document.removeEventListener("touchmove", onTouchMove);
        });
    }
    public clearAnalysisDrawing():void {
        this.pen_marks = [];
        if (this.pen_ctx) {
            this.pen_ctx.clearRect(0, 0, this.metrics.width, this.metrics.height);
        }
    }
    private xy2pen(x:number, y:number):[number, number] {
        let lx = this.draw_left_labels ? 0.0 : 1.0;
        let ly = this.draw_top_labels ? 0.0 : 1.0;
        return [Math.round(((x / this.square_size) + lx) * 64), Math.round(((y / this.square_size) + ly) * 64)];
    }
    private pen2xy(x:number, y:number):[number, number] {
        let lx = this.draw_left_labels ? 0.0 : 1.0;
        let ly = this.draw_top_labels ? 0.0 : 1.0;

        return [((x / 64) - lx) * this.square_size, ((y / 64) - ly) * this.square_size];
    }
    private setPenStyle(color:string):void {
        this.pen_ctx.strokeStyle = color;
        this.pen_ctx.lineWidth = Math.max(1, Math.round(this.square_size * 0.1));
        this.pen_ctx.lineCap = "round";
    }
    private onPenStart(ev:MouseEvent):void {
        this.attachPenCanvas();

        let pos = getRelativeEventPosition(ev);
        this.last_pen_position = this.xy2pen(pos.x, pos.y);
        this.current_pen_mark = {"color": this.analyze_subtool, "points": this.xy2pen(pos.x, pos.y)};
        this.pen_marks.push(this.current_pen_mark);
        this.setPenStyle(this.analyze_subtool);

        this.syncReviewMove({"pen": this.analyze_subtool, "pp": this.xy2pen(pos.x, pos.y)});
    }
    private onPenMove(ev:MouseEvent):void {
        let pos = getRelativeEventPosition(ev);
        let start = this.last_pen_position;
        let s = this.pen2xy(start[0], start[1]);
        let end = this.xy2pen(pos.x, pos.y);
        let e = this.pen2xy(end[0], end[1]);

        let dx = end[0] - start[0];
        let dy = end[1] - start[1];
        if (dx * dx + dy * dy < 64) {
            return;
        }

        this.last_pen_position = end;
        this.current_pen_mark.points.push(dx);
        this.current_pen_mark.points.push(dy);
        this.pen_ctx.beginPath();
        this.pen_ctx.moveTo(s[0], s[1]);
        this.pen_ctx.lineTo(e[0], e[1]);
        this.pen_ctx.stroke();

        this.syncReviewMove({"pp": [dx, dy]});
    }
    public drawPenMarks(penmarks:MoveTreePenMarks):void {
        if (this.review_id && !this.done_loading_review) { return; }
        if (!(penmarks.length || this.pen_layer)) {
            return;
        }
        this.attachPenCanvas();
        this.clearAnalysisDrawing();
        this.pen_marks = penmarks;
        for (let i = 0; i < penmarks.length; ++i) {
            let stroke = penmarks[i];
            this.setPenStyle(stroke.color);

            let px = stroke.points[0];
            let py = stroke.points[1];
            this.pen_ctx.beginPath();
            let pt = this.pen2xy(px, py);
            this.pen_ctx.moveTo(pt[0], pt[1]);
            for (let j = 2; j < stroke.points.length; j += 2 ) {
                px += stroke.points[j];
                py += stroke.points[j + 1];
                let pt = this.pen2xy(px, py);
                this.pen_ctx.lineTo(pt[0], pt[1]);
            }
            this.pen_ctx.stroke();
        }
    }
    private onTap(event:MouseEvent, double_tap:boolean):void {
        if (!(this.stone_placement_enabled && (this.player_id || this.engine.black_player_id === 0 || this.mode === "analyze" || this.mode === "pattern search" || this.mode === "puzzle"))) { return; }

        let pos = getRelativeEventPosition(event);
        let xx = pos.x;
        let yy = pos.y;


        let pt = this.xy2ij(xx, yy);
        let x = pt.i;
        let y = pt.j;

        if (x < 0 || y < 0 || x >= this.engine.width || y >= this.engine.height) {
            return;
        }

        if (!this.double_click_submit) {
            double_tap = false;
        }

        if (this.mode === "analyze" && event.shiftKey
            /* don't warp to move tree position when shift clicking in stone edit mode */
            && !(this.analyze_tool === "stone" && (this.analyze_subtool === "black" || this.analyze_subtool === "white"))
            /* nor when in labeling mode */
            && this.analyze_tool !== "label"
           ) {
            let m = this.engine.getMoveByLocation(x, y);
            if (m) {
                this.engine.jumpTo(m);
                this.emit("update");
            }
            return;
        }

        if (this.mode === "analyze" && this.analyze_tool === "label") {
            return;
        }

        this.setSubmit(null);
        if (this.submitBlinkTimer) {
            clearTimeout(this.submitBlinkTimer);
        }
        this.submitBlinkTimer = null;


        let tap_time = Date.now();
        let submit = () => {
            let submit_time = Date.now();
            if (!this.one_click_submit && (!this.double_click_submit || !double_tap)) {
                /* then submit button was pressed, so check to make sure this didn't happen too quick */
                let delta = submit_time - tap_time;
                if (delta <= 50) {
                    console.info("Submit button pressed only ", delta, "ms after stone was placed, presuming bad click");
                    return;
                }
            }
            this.last_sent_move = encodeMove(x, y);
            this.sendMove({
                "auth": this.config.auth,
                "game_id": this.config.game_id,
                "player_id": this.config.player_id,
                "move": encodeMove(x, y)
            });
            this.setTitle(_("Submitting..."));
            this.disableStonePlacement();
            this.move_selected = false;
        };
        /* we disable clicking if we've been initialized with the view user,
         * unless the board is a demo board (thus black_player_id is 0).  */
        try {
            let force_redraw = false;

            if ((this.engine.phase === "stone removal" || this.scoring_mode) && this.isParticipatingPlayer()) {
                let arrs;
                if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
                    let removed = !this.engine.removal[y][x];
                    arrs = [[removed, [{"x": x, "y": y}]]];
                }
                else {
                    arrs = this.engine.toggleMetaGroupRemoval(x, y);
                }

                for (let i = 0; i < arrs.length; ++i) {
                    let arr = arrs[i];

                    let removed = arr[0];
                    let group = arr[1];
                    if (group.length && !this.scoring_mode) {
                        this.socket.send("game/removed_stones/set", {
                            "auth"        : this.config.auth,
                            "game_id"     : this.config.game_id,
                            "player_id"   : this.config.player_id,
                            "removed"     : removed,
                            "stones"      : encodeMoves(group)
                        });
                    }
                    if (this.scoring_mode) {
                        this.score_estimate = this.engine.estimateScore(SCORE_ESTIMATION_TRIALS, SCORE_ESTIMATION_TOLERANCE);
                        this.redraw(true);
                    }
                }
            }
            else if (this.mode === "pattern search") {
                let color = (this.engine.board[y][x] + 1) % 3; /* cycle through the colors */
                if (this.pattern_search_color) {
                    color = this.pattern_search_color;
                    if (this.engine.board[y][x] === this.pattern_search_color) {
                        color = 0;
                    }
                }
                if (event.shiftKey && color === 1) { /* if we're going to place a black on an empty square but we're holding down shift, place white */
                    color = 2;
                }
                if (event.shiftKey && color === 2) { /* if we're going to place a black on an empty square but we're holding down shift, place white */
                    color = 1;
                }
                if (!double_tap) { /* we get called for each tap, then once for the final double tap so we only want to process this x2 */
                    this.engine.editPlace(x, y, color);
                }
                this.emit("update");
            }
            else if (this.mode === "puzzle") {
                let puzzle_mode = "place";
                let color = 0;
                if (this.getPuzzlePlacementSetting) {
                    let s = this.getPuzzlePlacementSetting();
                    puzzle_mode = s.mode;
                    color = s.color;
                    if (this.shift_key_is_down) {
                        color = color === 1 ? 2 : 1;
                    }
                }

                if (puzzle_mode === "place") {
                    if (!double_tap) { /* we get called for each tap, then once for the final double tap so we only want to process this x2 */
                        this.engine.place(x, y, true, false, true, false, false);
                        this.emit("puzzle-place", {x, y});
                    }
                }
                if (puzzle_mode === "play") {
                    /* we get called for each tap, then once for the final double tap so we only want to process this x2 */
                    /* Also, if we just placed a piece and the computer is waiting to place it's piece (autoplaying), then
                     * don't allow anything to be placed. */
                    if (!double_tap && !this.autoplaying_puzzle_move) {
                        let mv_x = x;
                        let mv_y = y;
                        let calls = 0;

                        if (this.engine.puzzle_player_move_mode !== "fixed" || this.engine.cur_move.lookupMove(x, y, this.engine.player, false)) {
                            let puzzle_place = (mv_x, mv_y) => {
                                ++calls;

                                this.engine.place(mv_x, mv_y, true, false, true, false, false);
                                this.emit("puzzle-place", {x : mv_x, y : mv_y});
                                if (this.engine.cur_move.wrong_answer) {
                                    this.emit("puzzle-wrong-answer");
                                }
                                if (this.engine.cur_move.correct_answer) {
                                    this.emit("puzzle-correct-answer");
                                }

                                if (this.engine.cur_move.branches.length === 0) {
                                    let isobranches = this.engine.cur_move.findStrongIsobranches();
                                    if (isobranches.length > 0) {
                                        let w = getRandomInt(0, isobranches.length);
                                        let which = isobranches[w];
                                        console.info("Following isomorphism (" + (w + 1) + " of " + isobranches.length + ")");
                                        this.engine.jumpTo(which);
                                        this.emit("update");
                                    }
                                }

                                if (this.engine.cur_move.branches.length) {
                                    let next = this.engine.cur_move.branches[getRandomInt(0, this.engine.cur_move.branches.length)];

                                    if (calls === 1
                                        && /* only move if it's the "ai" turn.. if we undo we can get into states where we
                                            * are playing for the ai for some moves so don't automove blindly */
                                        ((next.player === 2 && this.engine.config.initial_player === "black")
                                            || (next.player === 1 && this.engine.config.initial_player === "white"))
                                        && this.engine.puzzle_opponent_move_mode !== "manual"
                                       ) {
                                           this.autoplaying_puzzle_move = true;
                                           setTimeout(() => {
                                               this.autoplaying_puzzle_move = false;
                                               puzzle_place(next.x, next.y);
                                               this.emit("update");
                                           }, this.puzzle_autoplace_delay);
                                       }
                                } else {
                                    /* default to wrong answer, but only if there are no nodes prior to us that were marked
                                     * as correct */
                                    let c = this.engine.cur_move;
                                    let parent_was_correct = false;
                                    while (c) {
                                        if (c.correct_answer) {
                                            parent_was_correct = true;
                                            break;
                                        }
                                        c = c.parent;
                                    }
                                    if (!parent_was_correct) {
                                        /* default to wrong answer - we say ! here because we will have already emitted
                                         * puzzle-wrong-answer if wrong_answer was true above. */
                                        if (!this.engine.cur_move.wrong_answer) {
                                            this.emit("puzzle-wrong-answer");
                                        }
                                        //break;
                                    }
                                }
                            };
                            puzzle_place(x, y);
                        }
                    }
                }
                if (puzzle_mode === "setup") {
                    if (this.engine.board[y][x] === color) {
                        this.engine.initialStatePlace(x, y, 0);
                    } else {
                        this.engine.initialStatePlace(x, y, color);
                    }
                }
                this.emit("update");
            }
            else if (this.engine.phase === "play" || (this.engine.phase === "finished" && this.mode === "analyze")) {
                if (this.move_selected) {
                    if (this.mode === "play") {
                        this.engine.cur_move.removeIfNoChildren();
                    }

                    /* If same stone is clicked again, simply remove it */
                    let same_stone_clicked = false;
                    if ((this.move_selected.x === x && this.move_selected.y === y)) {
                        this.move_selected = false;
                        same_stone_clicked = true;
                    }

                    this.engine.jumpTo(this.engine.last_official_move);

                    /* If same stone is clicked again, simply remove it */
                    if (same_stone_clicked) {
                        this.updatePlayerToMoveTitle();
                        if (!double_tap) {
                            this.emit("update");
                            return;
                        }
                    }
                }
                this.move_selected = {"x": x, "y": y};

                /* Place our stone */
                try {
                    if ((this.mode !== "edit" || this.edit_color == null) &&
                        !(this.mode === "analyze" && this.analyze_tool === "stone" && this.analyze_subtool !== "alternate")) {
                        this.engine.place(x, y, true, true);

                        if (this.mode === "analyze") {
                            if (this.engine.handicapMovesLeft() > 0) {
                                this.engine.place(-1, -1);
                            }
                        }
                    } else {
                        let edit_color = this.engine.playerByColor(this.edit_color);
                        if (event.shiftKey && edit_color === 1) { /* if we're going to place a black on an empty square but we're holding down shift, place white */
                            edit_color = 2;
                        }
                        else if (event.shiftKey && edit_color === 2) { /* if we're going to place a black on an empty square but we're holding down shift, place white */
                            edit_color = 1;
                        }
                        if (this.engine.board[y][x] === edit_color) {
                            this.engine.editPlace(x, y, 0);
                        }
                        else {
                            this.engine.editPlace(x, y, edit_color);
                        }
                    }

                    if (this.mode === "analyze" && this.analyze_tool === "stone") {
                        let c = this.engine.cur_move;
                        while (c && !c.trunk) {
                            let mark:any = c.getMoveNumberDifferenceFromTrunk();
                            if (c.edited) {
                                mark = "triangle";
                            }

                            if (c.x >= 0 && c.y >= 0 && !(this.engine.board[c.y][c.x])) {
                                this.clearTransientMark(c.x, c.y, mark);
                            } else {
                                this.setTransientMark(c.x, c.y, mark, true);
                            }
                            c = c.parent;
                        }
                    }


                    if (this.isPlayerController()) {
                        this.syncReviewMove();
                        force_redraw = true;
                    }
                } catch (e) {
                    this.move_selected = false;
                    this.updatePlayerToMoveTitle();
                    throw e;
                }

                this.playMovementSound();

                switch (this.mode) {
                    case "play":
                        //if (this.one_click_submit || double_tap || this.engine.game_type === "temporary") {
                        if (this.one_click_submit || double_tap) {
                            submit();
                        }
                        else {
                            this.setSubmit(submit);
                        }
                        break;
                    case "analyze":
                        this.move_selected = false;
                        this.updateTitleAndStonePlacement();
                        this.emit("update");
                        break;
                    case "conditional":
                        this.followConditionalSegment(x, y);
                        this.move_selected = false;
                        this.updateTitleAndStonePlacement();
                        this.emit("update");
                        break;
                    case "edit":
                        this.move_selected = false;
                        this.updateTitleAndStonePlacement();
                        this.emit("update");

                        this.last_sent_move = encodeMove(x, y);
                        this.sendMove({
                            "auth": this.config.auth,
                            "game_id": this.config.game_id,
                            "player_id": this.config.player_id,
                            "move": "!" + this.engine.board[y][x] + encodeMove(x, y)
                        });
                        break;
                }

                if (force_redraw) {
                    this.redraw();
                }
            }

        } catch (e) {
            this.move_selected = false;
            console.info(e);
            this.errorHandler(e);
            this.emit("error");
            this.emit("update");
        }
    }
    private onMouseMove(event:MouseEvent):void {
        if (!(this.stone_placement_enabled &&
            (this.player_id || this.engine.black_player_id === 0 || this.mode === "analyze" || this.scoring_mode)
            )) { return; }

        let offset = elementOffset(this.board);
        let x = event.pageX - offset.left;
        let y = event.pageY - offset.top;

        let pt = this.xy2ij(x, y);

        if (this.__last_pt.i === pt.i && this.__last_pt.j === pt.j) {
            return;
        }

        if (this.__last_pt.valid) {
            let last_hover = this.last_hover_square;
            this.last_hover_square = null;
            if (last_hover) {
                this.drawSquare(last_hover.x, last_hover.y);
            }
        }

        this.__last_pt = pt;

        if (pt.valid) {
            this.last_hover_square = {"x": pt.i, "y": pt.j};
            this.drawSquare(pt.i, pt.j);
        }
    }
    private onMouseOut(event:MouseEvent):void {
        if (this.__last_pt.valid) {
            let last_hover = this.last_hover_square;
            this.last_hover_square = null;
            if (last_hover) {
                this.drawSquare(last_hover.x, last_hover.y);
            }
        }
        this.__last_pt = this.xy2ij(-1, -1);
    }
    public drawSquare(i:number, j:number):void {
        if (i < 0 || j < 0) { return; }
        if (this.__draw_state[j][i] !== this.drawingHash(i, j)) {
            this.__drawSquare(i, j);
        }
    }
    private __drawSquare(i:number, j:number):void {
        if (!this.drawing_enabled) { return; }
        if (this.no_display) { return; }
        let ctx = this.ctx;
        if (!ctx) { return; }
        if (i < 0 || j < 0) { return; }
        let s = this.square_size;
        let ox = this.draw_left_labels ? s : 0;
        let oy = this.draw_top_labels ? s : 0;
        if (this.bounds.left > 0) {
            ox = -s * this.bounds.left;
        }
        if (this.bounds.top > 0) {
            oy = -s * this.bounds.top;
        }

        let cx;
        let cy;
        let draw_last_move = !this.dont_draw_last_move;

        let stone_color = 0;
        if (this.engine) {
            stone_color = this.engine.board[j][i];
        }

        /* Figure out marks for this spot */
        let pos = this.getMarks(i, j);
        if (!pos) {
            console.error("No position for ", j, i);
            pos = {};
        }
        let altmarking = null;
        if (this.engine && this.engine.cur_move && (this.mode !== "play" || (typeof(this.isInPushedAnalysis()) !== "undefined" && this.isInPushedAnalysis()))) {
            for (let cur = this.engine.cur_move; !cur.trunk; cur = cur.parent) {
                if (cur.x === i && cur.y === j) {
                    let move_diff = cur.getMoveNumberDifferenceFromTrunk();
                    if (move_diff !== cur.move_number) {
                        altmarking = cur.edited ? null : (this.show_move_numbers ? cur.getMoveNumberDifferenceFromTrunk() : null);
                    }
                }
            }
        }

        let movetree_contains_this_square = false;
        if (this.engine && this.engine.cur_move.lookupMove(i, j, this.engine.player, false)) {
            movetree_contains_this_square = true;
        }

        let have_text_to_draw = false;
        let text_color = this.theme_blank_text_color;
        for (let key in pos) {
            if (key.length <= 3) {
                have_text_to_draw = true;
            }
        }
        if (pos.circle || pos.triangle || pos.chat_triangle || pos.sub_triangle || pos.cross || pos.square) {
            have_text_to_draw = true;
        }
        if (pos.letter && pos.letter.length > 0) {
            have_text_to_draw = true;
        }


        /* clear and draw lines */
        {
            let l = i * s + ox;
            let r = (i + 1) * s + ox;
            let t = j * s + oy;
            let b = (j + 1) * s + oy;

            ctx.clearRect(l, t, r - l, b - t);
            if (this.shadow_ctx) {
                let shadow_offset = this.square_size * 0.10;
                this.shadow_ctx.clearRect(l + shadow_offset, t + shadow_offset, this.square_size, this.square_size);
                shadow_offset = this.square_size * 0.20;
                this.shadow_ctx.clearRect(l + shadow_offset, t + shadow_offset, this.square_size, this.square_size);
                shadow_offset = this.square_size * 0.30;
                this.shadow_ctx.clearRect(l + shadow_offset, t + shadow_offset, this.square_size, this.square_size);
            }

            cx = l + this.metrics.mid;
            cy = t + this.metrics.mid;

            /* draw line */
            let sx = l;
            let ex = r;
            let mx = (r + l) / 2 - this.metrics.offset;
            let sy = t;
            let ey = b;
            let my = (t + b) / 2 - this.metrics.offset;

            if (i ===  0)               { sx += this.metrics.mid; }
            if (i ===  this.width - 1)  { ex -= this.metrics.mid; }
            if (j ===  0)               { sy += this.metrics.mid; }
            if (j ===  this.height - 1) { ey -= this.metrics.mid; }

            if (i ===  this.width - 1 && j ===  this.height - 1) {
                if (mx === ex && my === ey) {
                    ex += 1;
                    ey += 1;
                }
            }

            if (this.square_size < 5) {
                ctx.lineWidth = 0.2;
            } else {
                ctx.lineWidth = 1;
            }
            if (have_text_to_draw) {
                ctx.strokeStyle = this.theme_faded_line_color;
            } else {
                ctx.strokeStyle = this.theme_line_color;
            }
            ctx.lineCap = "butt";
            ctx.beginPath();
            ctx.moveTo(Math.floor(sx), my);
            ctx.lineTo(Math.floor(ex), my);
            ctx.moveTo(mx, Math.floor(sy));
            ctx.lineTo(mx, Math.floor(ey));
            ctx.stroke();
        }

        /* Draw star points */
        {
            let star_radius;
            if (this.square_size < 5) {
                star_radius = 0.5;
            } else {
                star_radius = Math.max(2, (this.metrics.mid - 1.5) * 0.16);
            }
            let draw_star_point = false;
            if (this.width === 19 && this.height === 19 &&
                (   (i === 3 && (j === 3 || j === 9 || j === 15))
                 || (i === 9 && (j === 3 || j === 9 || j === 15))
                 || (i === 15 && (j === 3 || j === 9 || j === 15))
                )
            ) {
                draw_star_point = true;
            }

            if (this.width === 13 && this.height === 13 &&
                (   (i === 3 && (j === 3 || j === 9))
                 || (i === 6 && (j === 6))
                 || (i === 9 && (j === 3 || j === 9))
                )
            ) {
                draw_star_point = true;
            }

            if (this.width === 9 && this.height === 9 &&
                (   (i === 2 && (j === 2 || j === 6))
                 || (i === 4 && (j === 4))
                 || (i === 6 && (j === 2 || j === 6))
                )
            ) {
                draw_star_point = true;
            }

            if (draw_star_point) {
                ctx.beginPath();
                ctx.fillStyle = this.theme_star_color;
                if (have_text_to_draw) {
                    ctx.fillStyle = this.theme_faded_star_color;
                }
                ctx.arc(cx, cy, star_radius, 0.001, 2 * Math.PI, false); /* 0.001 to workaround fucked up chrome 27 bug */
                ctx.fill();
            }
        }

        /* Heatmap */

        if (this.heatmap) {
            if (this.heatmap[j][i] > 0.001) {
                let color = "#00FF00";
                ctx.lineCap = "square";
                ctx.save();
                ctx.beginPath();
                ctx.globalAlpha = Math.min(this.heatmap[j][i], 0.5);
                let r = Math.floor(this.square_size * 0.5) - 0.5;
                ctx.moveTo(cx - r, cy - r);
                ctx.lineTo(cx + r, cy - r);
                ctx.lineTo(cx + r, cy + r);
                ctx.lineTo(cx - r, cy + r);
                ctx.lineTo(cx - r, cy - r);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.restore();
            }
        }



        /* Draw square highlights if any */
        {
            if (pos.hint || (
                this.highlight_movetree_moves && movetree_contains_this_square ||
                pos.color)) {

                let color = pos.color ? pos.color : pos.hint ? "#8EFF0A" : "#FF8E0A";

                ctx.lineCap = "square";
                ctx.save();
                ctx.beginPath();
                ctx.globalAlpha = 0.6;
                let r = Math.floor(this.square_size * 0.5) - 0.5;
                ctx.moveTo(cx - r, cy - r);
                ctx.lineTo(cx + r, cy - r);
                ctx.lineTo(cx + r, cy + r);
                ctx.lineTo(cx - r, cy + r);
                ctx.lineTo(cx - r, cy - r);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.restore();
            }
        }

        /* Colored stones */

        if (this.colored_circles) {
            if (this.colored_circles[j][i]) {
                let circle = this.colored_circles[j][i];
                let color = circle.color;

                ctx.save();
                ctx.globalAlpha = 1.0;
                let radius = Math.floor(this.square_size * 0.5) - 0.5;
                let lineWidth = radius * (circle.border_width || 0.10);

                if (lineWidth < 0.3) {
                    lineWidth = 0;
                }
                ctx.fillStyle = color;
                ctx.strokeStyle = circle.border_color || "#000000";
                if (lineWidth > 0) {
                    ctx.lineWidth = lineWidth;
                }
                ctx.beginPath();
                ctx.arc(cx, cy, radius - lineWidth / 2, 0.001, 2 * Math.PI, false); /* 0.001 to workaround fucked up chrome bug */
                if (lineWidth > 0) {
                    ctx.stroke();
                }
                ctx.fill();
                ctx.restore();

            }
        }



        /* Draw stones & hovers */
        {
            if (stone_color  /* if there is really a stone here */
                || (this.stone_placement_enabled
                    && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)
                    && (this.mode !== "analyze" || this.analyze_tool === "stone")
                    && this.engine
                    && !this.scoring_mode
                    && (this.engine.phase === "play" || (this.engine.phase === "finished" && this.mode === "analyze"))
                    && ((this.engine.puzzle_player_move_mode !== "fixed" || movetree_contains_this_square)
                        || this.getPuzzlePlacementSetting().mode !== "play")
                   )
                || (this.scoring_mode
                    && this.score_estimate
                    && this.score_estimate.board[j][i]
                    && this.score_estimate.removal[j][i]
                   )
                || (this.engine
                    && this.engine.phase === "stone removal"
                    && this.engine.board[j][i]
                    && this.engine.removal[j][i]
                   )
                || pos.black
                || pos.white
            ) {
                //let color = stone_color ? stone_color : (this.move_selected ? this.engine.otherPlayer() : this.engine.player);
                let transparent = false;
                let color;
                if (this.scoring_mode
                    && this.score_estimate
                    && this.score_estimate.board[j][i]
                    && this.score_estimate.removal[j][i]
                ) {
                    color = this.score_estimate.board[j][i];
                    transparent = true;
                }
                else if (this.engine && (this.engine.phase === "stone removal" || (this.engine.phase === "finished" && this.mode !== "analyze"))
                    && this.engine.board && this.engine.removal
                    && this.engine.board[j][i]
                    && this.engine.removal[j][i]
                ) {
                    color = this.engine.board[j][i];
                    transparent = true;
                }
                else if (stone_color) {
                    color = stone_color;
                }
                else if (this.mode === "edit" || (this.mode === "analyze" && this.analyze_tool === "stone" && this.analyze_subtool !== "alternate")) {
                    color = this.edit_color === "black" ? 1 : 2;
                    if (this.shift_key_is_down) {
                        color = this.edit_color === "black" ? 2 : 1;
                    }
                }
                else if (this.move_selected) {
                    if (this.engine.handicapMovesLeft() <= 0) {
                        color = this.engine.otherPlayer();
                    }   else {
                            color = this.engine.player;
                    }
                }
                else if (this.mode === "puzzle") {
                    if (this.getPuzzlePlacementSetting) {
                        let s = this.getPuzzlePlacementSetting();
                        if (s.mode === "setup") {
                            color = s.color;
                            if (this.shift_key_is_down) {
                                color = color === 1 ? 2 : 1;
                            }
                        } else {
                            color = this.engine.player;
                        }
                    } else {
                        color = this.engine.player;
                    }

                }
                else if (pos.black || pos.white) {
                    color = pos.black ? 1 : 2;
                    transparent = true;
                }
                else {
                    color = this.engine.player;

                    if (this.mode === "pattern search" && this.pattern_search_color) {
                        color = this.pattern_search_color;
                    }
                }


                if (!(this.autoplaying_puzzle_move && !stone_color)) {
                    text_color = color === 1 ? this.theme_black_text_color : this.theme_white_text_color;

                    if (!this.theme_black_stones) {
                        let err = new Error(`Goban.theme_black_stones not set. Current themes is ${JSON.stringify(this.themes)}`);
                        setTimeout(() => { throw err; }, 1);
                        return;
                    }
                    if (!this.theme_white_stones) {
                        let err = new Error(`Goban.theme_white_stones not set. Current themes is ${JSON.stringify(this.themes)}`);
                        setTimeout(() => { throw err; }, 1);
                        return;
                    }

                    ctx.save();
                    let shadow_ctx = this.shadow_ctx;
                    if (!stone_color || transparent) {
                        ctx.globalAlpha = 0.6;
                        shadow_ctx = null;
                    }
                    if (color === 1) {
                        let stone = this.theme_black_stones[((i + 1) * 53) * ((j + 1) * 97) % this.theme_black_stones.length];
                        this.theme_black.placeBlackStone(ctx, shadow_ctx, stone, cx, cy, this.theme_stone_radius);
                    } else {
                        let stone = this.theme_white_stones[((i + 1) * 53) * ((j + 1) * 97) % this.theme_white_stones.length];
                        this.theme_white.placeWhiteStone(ctx, shadow_ctx, stone, cx, cy, this.theme_stone_radius);
                    }
                    ctx.restore();
                }
            }
        }

        /* Draw delete X's */
        {
            let draw_x = false;
            let transparent_x = false;
            if (this.engine && (this.scoring_mode || this.engine.phase === "stone removal") && this.stone_placement_enabled
                && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)
                && (this.mode !== "analyze" || this.analyze_tool === "stone")) {
                draw_x = true;
                transparent_x = true;
            }

            if (pos.mark_x) {
                draw_x = true;
                transparent_x = false;
            }

            draw_x = false;


            if (draw_x) {
                ctx.beginPath();
                ctx.save();
                ctx.strokeStyle = "#ff0000";
                ctx.lineWidth = this.square_size * 0.175;
                if (transparent_x) {
                    ctx.globalAlpha = 0.6;
                }
                let r = Math.max(1, this.metrics.mid * 0.7);
                ctx.moveTo(cx - r, cy - r);
                ctx.lineTo(cx + r, cy + r);
                ctx.moveTo(cx + r, cy - r);
                ctx.lineTo(cx - r, cy + r);
                ctx.stroke();
                ctx.restore();
            }
        }

        /* Draw Scores */
        {
            if ((pos.score && (this.engine.phase !== "finished" ||  this.mode === "play"))
                || (this.scoring_mode
                     && this.score_estimate
                     && (this.score_estimate.territory[j][i]
                         || (this.score_estimate.removal[j][i] && this.score_estimate.board[j][i] === 0)
                    ))
                || (
                    (this.engine.phase === "stone removal"
                     || ( this.engine.phase === "finished" && this.mode === "play")
                    ) &&
                    this.engine.board[j][i] === 0 && this.engine.removal[j][i])
                  ) {
                ctx.beginPath();

                let color = pos.score;
                if (this.scoring_mode
                    && this.score_estimate
                    && (this.score_estimate.territory[j][i] || (this.score_estimate.removal[j][i] && this.score_estimate.board[j][i] === 0))) {
                    color = this.score_estimate.territory[j][i] === 1 ? "black" : "white";
                    if (this.score_estimate.board[j][i] === 0 && this.score_estimate.removal[j][i]) {
                        color = "dame";
                    }
                }

                if ((this.engine.phase === "stone removal" || (this.engine.phase === "finished" && this.mode === "play")) &&
                    this.engine.board[j][i] === 0 && this.engine.removal[j][i]) {
                    color = "dame";
                }

                if (color === "white") {
                    ctx.fillStyle = this.theme_black_text_color;
                    ctx.strokeStyle = "#777777";
                }
                else if (color === "black") {
                    ctx.fillStyle = this.theme_white_text_color;
                    ctx.strokeStyle = "#888888";
                }
                else if (color === "dame") {
                    ctx.fillStyle = "#ff0000";
                    ctx.strokeStyle = "#365FE6";
                }
                ctx.lineWidth = Math.ceil(this.square_size * 0.065) - 0.5;

                let r = this.square_size * 0.15;
                ctx.rect(cx - r, cy - r, r * 2, r * 2);
                if (color !== "dame") {
                    ctx.fill();
                }
                ctx.stroke();
            }
        }



        /* Draw letters and numbers */
        let letter_was_drawn = false;
        {
            let letter = null;
            let transparent = false;
            if ("letter" in pos && pos.letter.length > 0) {
                letter = pos.letter;
            }

            if (this.mode === "play" && this.byoyomi_label && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                letter = this.byoyomi_label;
            }
            if (this.mode === "analyze" && this.analyze_tool === "label" && (this.analyze_subtool === "letters" || this.analyze_subtool === "numbers")
                && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                transparent = true;
                letter = this.label_character;
            }
            if (!letter && altmarking !== "triangle") {
                letter = altmarking;
            }


            if (this.show_variation_move_numbers
                && !letter
                && !(pos.circle || pos.triangle || pos.chat_triangle || pos.sub_triangle || pos.cross || pos.square)
            ) {
                let m = this.engine.getMoveByLocation(i, j);
                if (m && !m.trunk) {
                    if (m.edited) {
                        //letter = "triangle";
                        if (this.engine.board[j][i]) {
                            altmarking = "triangle";
                        }
                    } else {
                        letter = m.getMoveNumberDifferenceFromTrunk();
                    }
                }
            }


            if (letter) {
                letter_was_drawn = true;
                ctx.save();
                ctx.fillStyle = text_color;
                let metrics = ctx.measureText(letter);

                if (metrics.width > this.square_size) {
                    /* For some wide labels, our default font size is too large.. so
                     * for those labels, set the font size down. This is a slow
                     * operation to do on every square, so we don't want to dynamically
                     * size them like this unless we have to.  */
                    ctx.font = "bold " + (Math.round(this.square_size * 0.35)) + "px " + GOBAN_FONT;
                    metrics = ctx.measureText(letter);
                }

                let xx = cx - metrics.width / 2;
                let yy = cy + (/WebKit|Trident/.test(navigator.userAgent) ? this.square_size * -0.03 : 1); /* middle centering is different on firefox */
                ctx.textBaseline = "middle";
                if (transparent) {
                    ctx.globalAlpha = 0.6;
                }
                ctx.fillText(letter, xx, yy);
                draw_last_move = false;
                ctx.restore();
            }
        }

        /* draw special symbols */
        {
            let transparent = letter_was_drawn;
            let hovermark = null;
            let symbol_color = stone_color === 1 ? this.theme_black_text_color : stone_color === 2 ? this.theme_white_text_color : text_color;

            if (this.analyze_tool === "label" && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                if (this.analyze_subtool === "triangle" || this.analyze_subtool === "square" || this.analyze_subtool === "cross" || this.analyze_subtool === "circle") {
                    transparent = true;
                    hovermark = this.analyze_subtool;
                }
            }



            if (pos.circle || hovermark === "circle") {
                ctx.lineCap = "round";
                ctx.save();
                ctx.beginPath();
                if (transparent) {
                    ctx.globalAlpha = 0.6;
                }
                ctx.strokeStyle = symbol_color;
                ctx.lineWidth = this.square_size * 0.075;
                ctx.arc(cx, cy, this.square_size * 0.25, 0, 2 * Math.PI, false);
                ctx.stroke();
                ctx.restore();
                draw_last_move = false;
            }
            if (pos.triangle || pos.chat_triangle || pos.sub_triangle || altmarking === "triangle" || hovermark === "triangle") {
                let scale = 1.0;
                let oy = 0.0;
                if (pos.sub_triangle) {
                    scale = 0.5;
                    oy = this.square_size * 0.30;
                    transparent = false;
                }
                ctx.lineCap = "round";
                ctx.save();
                ctx.beginPath();
                if (transparent) {
                    ctx.globalAlpha = 0.6;
                }
                ctx.strokeStyle = symbol_color;
                if (pos.chat_triangle) {
                    ctx.strokeStyle = "#00aaFF";
                }
                ctx.lineWidth = this.square_size * 0.075 * scale;
                let theta = -(Math.PI * 2) / 4;
                let r = this.square_size * 0.30 * scale;
                ctx.moveTo(cx + r * Math.cos(theta), cy + oy + r * Math.sin(theta));
                theta += (Math.PI * 2) / 3; ctx.lineTo(cx + r * Math.cos(theta), cy + oy + r * Math.sin(theta));
                theta += (Math.PI * 2) / 3; ctx.lineTo(cx + r * Math.cos(theta), cy + oy + r * Math.sin(theta));
                theta += (Math.PI * 2) / 3; ctx.lineTo(cx + r * Math.cos(theta), cy + oy + r * Math.sin(theta));
                ctx.stroke();
                ctx.restore();
                draw_last_move = false;
            }
            if (pos.cross || hovermark === "cross") {
                ctx.lineCap = "square";
                ctx.save();
                ctx.beginPath();
                ctx.lineWidth = this.square_size * 0.075;
                if (transparent) {
                    ctx.globalAlpha = 0.6;
                }
                let r = Math.max(1, this.metrics.mid * 0.35);
                ctx.moveTo(cx - r, cy - r);
                ctx.lineTo(cx + r, cy + r);
                ctx.moveTo(cx + r, cy - r);
                ctx.lineTo(cx - r, cy + r);
                ctx.strokeStyle = symbol_color;
                ctx.stroke();
                ctx.restore();
                draw_last_move = false;
            }

            if (pos.square || hovermark === "square") {
                ctx.lineCap = "square";
                ctx.save();
                ctx.beginPath();
                ctx.lineWidth = this.square_size * 0.075;
                if (transparent) {
                    ctx.globalAlpha = 0.6;
                }
                let r = Math.max(1, this.metrics.mid * 0.40);
                ctx.moveTo(cx - r, cy - r);
                ctx.lineTo(cx + r, cy - r);
                ctx.lineTo(cx + r, cy + r);
                ctx.lineTo(cx - r, cy + r);
                ctx.lineTo(cx - r, cy - r);
                ctx.strokeStyle = symbol_color;
                ctx.stroke();
                ctx.restore();
                draw_last_move = false;
            }

        }


        /* Clear last move */
        if (this.last_move && this.engine && !this.last_move.is(this.engine.cur_move)) {
            let m = this.last_move;
            this.last_move = null;
            this.drawSquare(m.x, m.y);
        }

        /* Draw last move */
        if (draw_last_move && this.engine && this.engine.cur_move) {
            if (this.engine.cur_move.x === i && this.engine.cur_move.y === j && this.engine.board[j][i] &&
                  (this.engine.phase === "play" || (this.engine.phase === "finished"))
            ) {
                let xx = -1;
                let yy = -1;
                this.last_move = this.engine.cur_move;

                let r = this.square_size * 0.35;

                if (i >= 0 && j >= 0) {
                    ctx.beginPath();
                    ctx.strokeStyle = stone_color === 1 ? this.theme_black_text_color : this.theme_white_text_color;
                    ctx.lineWidth = this.square_size * 0.075;
                    ctx.arc(cx, cy, this.square_size * 0.25, 0, 2 * Math.PI, false);
                    ctx.stroke();
                }
            }
        }


        /* Score Estimation */

        if (this.scoring_mode && this.score_estimate) {
            let se = this.score_estimate;
            let est = se.heat[j][i];

            ctx.beginPath();

            let color = est < 0 ? "white" : "black";

            if (color === "white") {
                ctx.fillStyle = this.theme_black_text_color;
                ctx.strokeStyle = "#777777";
            }
            else if (color === "black") {
                ctx.fillStyle = this.theme_white_text_color;
                ctx.strokeStyle = "#888888";
            }
            ctx.lineWidth = Math.ceil(this.square_size * 0.035) - 0.5;
            let r = this.square_size * 0.20 * Math.abs(est) ;
            ctx.rect(cx - r, cy - r, r * 2, r * 2);
            ctx.fill();
            ctx.stroke();
        }



        this.__draw_state[j][i] = this.drawingHash(i, j);
    }
    private drawingHash(i:number, j:number):string {
        if (i < 0 || j < 0) {
            return "..";
        }

        let ret = this.square_size + ",";

        let draw_last_move = !this.dont_draw_last_move;
        let stone_color = 0;
        if (this.engine) {
            stone_color = this.engine.board[j][i];
        }


        ret += stone_color + ",";

        /* Draw heatmap */
        if (this.heatmap) {
            if (this.heatmap[j][i] > 0.001) {
                ret += "heat " + this.heatmap[j][i] + ",";
            }
        }

        /* Colored stones */
        if (this.colored_circles) {
            if (this.colored_circles[j][i]) {
                let circle = this.colored_circles[j][i];
                ret += "circle " + circle.color;
            }
        }

        /* Figure out marks for this spot */
        let pos = this.getMarks(i, j);
        if (!pos) {
            console.error("No position for ", j, i);
            pos = {};
        }
        let altmarking = null;
        if (this.engine && this.engine.cur_move && (this.mode !== "play" || (typeof(this.isInPushedAnalysis()) !== "undefined" && this.isInPushedAnalysis()))) {
            for (let cur = this.engine.cur_move; !cur.trunk; cur = cur.parent) {
                if (cur.x === i && cur.y === j) {
                    let move_diff = cur.getMoveNumberDifferenceFromTrunk();
                    if (move_diff !== cur.move_number) {
                        altmarking = cur.edited ? null : (this.show_move_numbers ? cur.getMoveNumberDifferenceFromTrunk() : null);
                    }
                }
            }
        }

        let movetree_contains_this_square = false;
        if (this.engine && this.engine.cur_move.lookupMove(i, j, this.engine.player, false)) {
            movetree_contains_this_square = true;
        }

        /* Draw stones & hovers */
        {
            if (stone_color   /* if there is really a stone here */
                || (this.stone_placement_enabled
                    && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)
                    && (this.mode !== "analyze" || this.analyze_tool === "stone")
                    && this.engine
                    && !this.scoring_mode
                    && (this.engine.phase === "play" || (this.engine.phase === "finished" && this.mode === "analyze"))
                    && ((this.engine.puzzle_player_move_mode !== "fixed" || movetree_contains_this_square)
                        || this.getPuzzlePlacementSetting().mode !== "play")
                   )
                || (this.scoring_mode
                    && this.score_estimate
                    && this.score_estimate.board[j][i]
                    && this.score_estimate.removal[j][i]
                   )
                || (this.engine
                    && this.engine.phase === "stone removal"
                    && this.engine.board[j][i]
                    && this.engine.removal[j][i]
                   )
                || pos.black
                || pos.white
            ) {
                let transparent = false;
                let color;
                if (this.scoring_mode
                    && this.score_estimate
                    && this.score_estimate.board[j][i]
                    && this.score_estimate.removal[j][i]
                ) {
                    color = this.score_estimate.board[j][i];
                    transparent = true;
                }
                else if (this.engine && this.engine.phase === "stone removal"
                    && this.engine.board && this.engine.removal
                    && this.engine.board[j][i]
                    && this.engine.removal[j][i]
                ) {
                    color = this.engine.board[j][i];
                    transparent = true;
                }
                else if (stone_color) {
                    color = stone_color;
                }
                else if (this.mode === "edit" || (this.mode === "analyze" && this.analyze_tool === "stone" && this.analyze_subtool !== "alternate")) {
                    color = this.edit_color === "black" ? 1 : 2;
                }
                else if (this.move_selected) {
                    if (this.engine.handicapMovesLeft() <= 0) {
                        color = this.engine.otherPlayer();
                    }   else {
                            color = this.engine.player;
                    }
                }
                else if (pos.black || pos.white) {
                    color = pos.black ? 1 : 2;
                    transparent = true;
                }
                else {
                    color = this.engine.player;
                }

                ret += (transparent ? "T" : "") + color + ",";
            }
        }

        /* Draw square highlights if any */
        {
            if (pos.hint || (this.highlight_movetree_moves && movetree_contains_this_square)) {
                if (pos.hint) {
                    ret += "hint,";
                } else {
                    ret += "highlight,";
                }
            }
        }



        /* Draw delete X's */
        {
            let draw_x = false;
            let transparent = false;
            if (this.engine && (this.scoring_mode || this.engine.phase === "stone removal") && this.stone_placement_enabled
                && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)
                && (this.mode !== "analyze" || this.analyze_tool === "stone")) {
                draw_x = true;
                transparent = true;
            }

            if (pos.mark_x) {
                draw_x = true;
                transparent = false;
            }

            if (this.scoring_mode && this.score_estimate && this.score_estimate.removal[j][i]) {
                draw_x = true;
                transparent = false;
            }

            if (pos.remove && (this.mode !== "analyze")) {
                draw_x = true;
                transparent = false;
            }

            ret += draw_x + "," + transparent;
        }

        /* Draw Scores */
        {
            if ((pos.score && (this.engine.phase !== "finished" ||  this.mode === "play"))
                || (this.scoring_mode && this.score_estimate && (this.score_estimate.territory[j][i] || (this.score_estimate.removal[j][i] && this.score_estimate.board[j][i] === 0)))
                || ((this.engine.phase === "stone removal" || (this.engine.phase === "finished" && this.mode === "play")) &&
                    this.engine.board[j][i] === 0 && this.engine.removal[j][i])
                ) {

                let color = pos.score;
                if (this.scoring_mode && this.score_estimate && (this.score_estimate.territory[j][i] || (this.score_estimate.removal[j][i] && this.score_estimate.board[j][i] === 0))) {
                    color = this.score_estimate.territory[j][i] === 1 ? "black" : "white";
                    if (this.score_estimate.board[j][i] === 0 && this.score_estimate.removal[j][i]) {
                        color = "dame";
                    }
                }

                if ((this.engine.phase === "stone removal" || (this.engine.phase === "finished" && this.mode === "play")) &&
                    this.engine.board[j][i] === 0 && this.engine.removal[j][i]) {
                    color = "dame";
                }

                if (this.scoring_mode && this.score_estimate && this.score_estimate.territory[j][i]) {
                    color = this.score_estimate.territory[j][i] === 1 ? "black" : "white";
                }
                ret += "score " + color + ",";
            }
        }



        /* Draw letters and numbers */
        {
            let letter = null;
            let transparent = false;
            if ("letter" in pos && pos.letter.length > 0) {
                letter = pos.letter;
            }
            if (this.mode === "play" && this.byoyomi_label && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                //transparent = true;
                letter = this.byoyomi_label;
            }
            if (this.mode === "analyze" && this.analyze_tool === "label"
                && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                transparent = true;
                letter = this.label_character;
            }
            if (!letter && altmarking !== "triangle") {
                letter = altmarking;
            }

            if (this.show_variation_move_numbers
                && !letter
                && !(pos.circle || pos.triangle || pos.chat_triangle || pos.cross || pos.square)
            ) {
                let m = this.engine.getMoveByLocation(i, j);
                if (m && !m.trunk) {
                    if (m.edited) {
                        //letter = "triangle";
                        if (this.engine.board[j][i]) {
                            altmarking = "triangle";
                        }
                    } else {
                        letter = m.getMoveNumberDifferenceFromTrunk();
                    }
                }
            }

            if (letter) {
                ret += letter + (transparent ? " fade" : "") + ",";
            }
        }

        /* draw special symbols */
        {
            let hovermark;
            if (this.analyze_tool === "label" && (this.last_hover_square && this.last_hover_square.x === i && this.last_hover_square.y === j)) {
                if (this.analyze_subtool === "triangle" || this.analyze_subtool === "square" || this.analyze_subtool === "cross" || this.analyze_subtool === "circle") {
                    hovermark = this.analyze_subtool;
                    ret += "hover " + this.analyze_subtool + ",";
                }
            }


            if (pos.circle) {
                ret += "circle,";
            }
            if (pos.triangle || pos.chat_triangle || altmarking === "triangle") {
                ret += "triangle,";
            }
            if (pos.cross) {
                ret += "cross,";
            }
            if (pos.square) {
                ret += "square,";
            }
        }


        /* Draw last move */
        if (draw_last_move && this.engine && this.engine.cur_move) {
            if (this.engine.cur_move.x === i && this.engine.cur_move.y === j && this.engine.board[j][i] &&
                  (this.engine.phase === "play" || (this.engine.phase === "finished"))
            ) {
                ret += "last_move,";
            }
        }

        return ret;
    }
    public redraw(force_clear?: boolean):void {
        if (!this.ready_to_draw) {
            return;
        }
        if (!this.drawing_enabled) {
            return;
        }
        if (this.no_display) { return; }

        let start = new Date();

        let metrics = this.metrics = this.computeMetrics();
        if (force_clear || !(this.__set_board_width === metrics.width && this.__set_board_height === metrics.height && this.theme_stone_radius === this.computeThemeStoneRadius(metrics))) {
            try {
                //this.parent.css({"width": metrics.width + "px", "height": metrics.height + "px"});
                this.parent.style.width = metrics.width + "px";
                this.parent.style.height = metrics.height + "px";
                resizeDeviceScaledCanvas(this.board, metrics.width, metrics.height);

                //let bo = this.board.offset();
                //let po = this.parent.offset() || {"top": 0, "left": 0};
                let bo = elementOffset(this.board);
                let po = elementOffset(this.parent) || {"top": 0, "left": 0};
                let top = bo.top - po.top;
                let left = bo.left - po.left;

                this.layer_offset_left = 0;
                this.layer_offset_top = 0;

                if (this.pen_layer) {
                    if (this.pen_marks.length) {
                        resizeDeviceScaledCanvas(this.pen_layer, metrics.width, metrics.height);
                        //this.pen_layer.css({"left": this.layer_offset_left, "top": this.layer_offset_top});
                        this.pen_layer.style.left = this.layer_offset_left;
                        this.pen_layer.style.top = this.layer_offset_top;
                        this.pen_ctx = this.pen_layer.getContext("2d");
                    } else {
                        this.detachPenCanvas();
                    }
                }

                this.__set_board_width = metrics.width;
                this.__set_board_height = metrics.height;
                this.ctx = this.board.getContext("2d");

                this.setThemes(this.getSelectedThemes(), true);
            } catch (e) {
                setTimeout(() => { throw e; }, 1);
                return;
            }
        }
        let ctx = this.ctx;


        let place = (ch, x, y) => { /* places centered (horizontally & veritcally) text at x,y */
            let metrics = ctx.measureText(ch);
            let xx = x - metrics.width / 2;
            let yy = y;
            ctx.fillText(ch, xx, yy);
        };
        let vplace = (ch, x, y) => { /* places centered (horizontally & veritcally) text at x,y, with text going down vertically. */
            for (let i = 0; i < ch.length; ++i) {
                let metrics = ctx.measureText(ch[i]);
                let xx = x - metrics.width / 2;
                let yy = y;
                let H = metrics.width; /* should be height in an ideal world, measureText doesn't seem to return it though. For our purposes this works well enough though. */

                if (ch.length === 2) {
                    yy = yy - H + (i * H);
                }
                if (ch.length === 3) {
                    yy = yy - (H * 1.5) + (i * H);
                }

                ctx.fillText(ch[i], xx, yy);
            }
        };

        let drawHorizontal = (i, j) => {
            switch (this.getCoordinateDisplaySystem()) {
                case 'A1':
                    for (let c = 0; c < this.width; ++i, ++c) {
                        let x = (i - this.bounds.left - (this.bounds.left > 0 ? +this.draw_left_labels : 0)) * this.square_size + this.square_size / 2;
                        let y = j * this.square_size + this.square_size / 2;
                        place("ABCDEFGHJKLMNOPQRSTUVWXYZ"[c], x, y);
                    }
                    break;
                case '1-1':
                    for (let c = 0; c < this.width; ++i, ++c) {
                        let x = (i - this.bounds.left - (this.bounds.left > 0 ? +this.draw_left_labels : 0)) * this.square_size + this.square_size / 2;
                        let y = j * this.square_size + this.square_size / 2;
                        place('' + (c + 1), x, y);
                    }
                    break;
            }
        };

        let drawVertical = (i, j) => {
            switch (this.getCoordinateDisplaySystem()) {
                case 'A1':
                    for (let c = 0; c < this.height; ++j, ++c) {
                        let x = i * this.square_size + this.square_size / 2;
                        let y = (j - this.bounds.top - (this.bounds.top > 0 ? +this.draw_top_labels : 0)) * this.square_size + this.square_size / 2;
                        place("" + (this.height - c), x, y);
                    }
                    break;
                case '1-1':
                    let chinese_japanese_numbers = [
                        "一", "二", "三", "四", "五",
                        "六", "七", "八", "九", "十",
                        "十一", "十二", "十三", "十四", "十五",
                        "十六", "十七", "十八", "十九", "二十",
                        "二十一", "二十二", "二十三", "二十四", "二十五",
                    ];
                    for (let c = 0; c < this.height; ++j, ++c) {
                        let x = i * this.square_size + this.square_size / 2;
                        let y = (j - this.bounds.top - (this.bounds.top > 0 ? +this.draw_top_labels : 0)) * this.square_size + this.square_size / 2;
                        vplace(chinese_japanese_numbers[c], x, y);
                    }
                    break;
            }
        };

        if (force_clear || !this.__borders_initialized) {
            this.__borders_initialized = true;
            if (this.shadow_ctx) {
                this.shadow_ctx.clearRect (0, 0, metrics.width, metrics.height);
            }
            ctx.clearRect (0, 0, metrics.width, metrics.height);

            /* Draw labels */
            let text_size = Math.round(this.square_size * 0.5);
            let bold = 'bold';
            if (this.getCoordinateDisplaySystem() === '1-1') {
                text_size *= 0.7;
                bold = '';

                if (this.height > 20) {
                    text_size *= 0.7;
                }
            }

            ctx.font = `${bold} ${text_size}px ${GOBAN_FONT}`;
            ctx.textBaseline = "middle";
            ctx.fillStyle = this.theme_board.getLabelTextColor();
            ctx.save();

            if (this.draw_top_labels && this.bounds.top === 0) {
                drawHorizontal(this.draw_left_labels, 0);
            }
            if (this.draw_bottom_labels && this.bounds.bottom === this.height - 1) {
                drawHorizontal(this.draw_left_labels, +this.draw_top_labels + this.bounded_height);
            }
            if (this.draw_left_labels && this.bounds.left === 0) {
                drawVertical(0, this.draw_top_labels);
            }
            if (this.draw_right_labels && this.bounds.right === this.width - 1) {
                drawVertical(+this.draw_left_labels + this.bounded_width, +this.draw_top_labels);
            }

            ctx.restore();
        }

        /* Draw squares */
        if (!this.__draw_state || force_clear || this.__draw_state.length !== this.height || this.__draw_state[0].length !== this.width) {
            this.__draw_state = GoMath.makeMatrix(this.width, this.height);
        }


        /* Set font for text overlay */
        {
            let text_size = Math.round(this.square_size * 0.45);
            ctx.font = "bold " + text_size + "px " + GOBAN_FONT;
        }

        for (let j = this.bounds.top; j <= this.bounds.bottom; ++j) {
            for (let i = this.bounds.left; i <= this.bounds.right; ++i) {
                this.drawSquare(i, j);
            }
        }

        let stop = new Date();
        this.drawPenMarks(this.pen_marks);
        this.move_tree_redraw();
    }
    public message(msg:string, timeout:number = 5000):void {
        this.clearMessage();

        this.message_div = document.createElement('div');
        this.message_div.className = "GobanMessage";
        this.message_td = document.createElement("td");
        let table = document.createElement("table");
        let tr = document.createElement("tr");
        tr.appendChild(this.message_td);
        table.appendChild(tr);
        this.message_div.appendChild(table);
        this.message_text = document.createElement("div");
        this.message_text.innerHTML = msg;
        this.message_td.append(this.message_text);
        this.parent.append(this.message_div);

        this.message_div.addEventListener("click", () => {
            if (timeout > 0) {
                this.clearMessage();
            }
        });

        if (!timeout) {
            timeout = 5000;
        }

        if (timeout > 0) {
            this.message_timeout = window.setTimeout(() => {
                this.clearMessage();
            }, timeout);
        }
    }
    public clearMessage():void {
        if (this.message_div) {
            this.message_div.remove();
            this.message_div = null;
        }
        if (this.message_timeout) {
            clearTimeout(this.message_timeout);
            this.message_timeout = null;
        }
    }
    protected setThemes(themes:GobanSelectedThemes, dont_redraw:boolean):void {
        if (this.no_display) {
            return;
        }

        this.themes = themes;

        this.theme_board = new (GoThemes["board"][themes.board])();
        this.theme_white = new (GoThemes["white"][themes.white])(this.theme_board);
        this.theme_black = new (GoThemes["black"][themes.black])(this.theme_board);

        if (!this.metrics) {
            this.metrics = this.computeMetrics();
        }
        this.theme_stone_radius = this.computeThemeStoneRadius(this.metrics);
        if (isNaN(this.theme_stone_radius)) {
            console.error("setThemes was not able to find the board size, metrics were: ", JSON.stringify(this.metrics));
            throw new Error("invalid stone radius computed");
        }

        if (this.theme_white.stoneCastsShadow(this.theme_stone_radius) || this.theme_black.stoneCastsShadow(this.theme_stone_radius)) {
            if (this.shadow_layer) {
                resizeDeviceScaledCanvas(this.shadow_layer, this.metrics.width, this.metrics.height);
                //this.shadow_layer.css({"left": this.layer_offset_left, "top": this.layer_offset_top});
                this.shadow_layer.style.left = this.layer_offset_left;
                this.shadow_layer.style.top = this.layer_offset_top;
                this.shadow_ctx = this.shadow_layer.getContext("2d");
            } else {
                this.attachShadowLayer();
            }
        } else {
            this.detachShadowLayer();
        }


        if (!(themes.white in __theme_cache.white)) { __theme_cache.white[themes.white] = {}; }
        if (!(themes.black in __theme_cache.black)) { __theme_cache.black[themes.black] = {}; }
        if (!(this.theme_stone_radius in __theme_cache.white[themes.white])) {
            __theme_cache.white[themes.white][this.theme_stone_radius] = this.theme_white.preRenderWhite(this.theme_stone_radius, 23434);
        }
        if (!(this.theme_stone_radius in __theme_cache.black[themes.black])) {
            __theme_cache.black[themes.black][this.theme_stone_radius] = this.theme_black.preRenderBlack(this.theme_stone_radius, 2081);
        }

        if (!(MoveTree.stone_radius in __theme_cache.white[themes.white])) {
            __theme_cache.white[themes.white][MoveTree.stone_radius] = this.theme_white.preRenderWhite(MoveTree.stone_radius, 23434);
        }
        if (!(MoveTree.stone_radius in __theme_cache.black[themes.black])) {
            __theme_cache.black[themes.black][MoveTree.stone_radius] = this.theme_black.preRenderBlack(MoveTree.stone_radius, 2081);
        }


        this.theme_white_stones = __theme_cache.white[themes.white][this.theme_stone_radius];
        this.theme_black_stones = __theme_cache.black[themes.black][this.theme_stone_radius];
        this.theme_line_color = this.theme_board.getLineColor();
        this.theme_faded_line_color = this.theme_board.getFadedLineColor();
        this.theme_star_color = this.theme_board.getStarColor();
        this.theme_faded_star_color = this.theme_board.getFadedStarColor();
        this.theme_blank_text_color = this.theme_board.getBlankTextColor();
        this.theme_black_text_color = this.theme_black.getBlackTextColor();
        this.theme_white_text_color = this.theme_white.getWhiteTextColor();
        //this.parent.css(this.theme_board.getBackgroundCSS());
        let bgcss = this.theme_board.getBackgroundCSS();
        for (let key in bgcss) {
            this.parent.style[key] = bgcss[key];
        }

        if (!dont_redraw) {
            this.redraw(true);
            this.move_tree_redraw();
        }
    }


    //
    // Move tree
    //
    //private redraw_on_scroll: any;
    private move_tree_on_scroll: (event:Event) => void;

    public move_tree_redraw(no_warp?:boolean):void {
        if (!this.move_tree_container) {
            return;
        }

        if (!this.move_tree_inner_container) {
            this.move_tree_inner_container = document.createElement('div');
            this.move_tree_canvas = document.createElement('canvas');
            this.move_tree_inner_container.appendChild(this.move_tree_canvas);
            this.move_tree_container.appendChild(this.move_tree_inner_container);
            this.move_tree_bindCanvasEvents(this.move_tree_canvas);
            this.move_tree_container.style.position = 'relative';
            this.move_tree_canvas.style.position = 'absolute';

            let move_tree_on_scroll = (event:Event) => {
                this.move_tree_redraw(true);
            };
            this.move_tree_container.addEventListener('scroll', move_tree_on_scroll);
            this.on('destroy', () => {
                this.move_tree_container.removeEventListener('scroll', move_tree_on_scroll);
            });

            try {
                let observer = new ResizeObserver(() => {
                    this.move_tree_redraw(true);
                }).observe(this.move_tree_container);
                this.on('destroy', () => { observer.disconnect(); });
            } catch (e) {
                // ResizeObserver is still fairly new and might not exist
            }
        }

        if (this.move_tree_inner_container.parentNode !== this.move_tree_container) {
            this.move_tree_container.appendChild(this.move_tree_inner_container);
        }


        /*
        if (this.move_tree_canvas.width !== this.move_tree_container.outerWidth ||
            this.move_tree_canvas.height !== this.move_tree_container.outerHeight
        ) {
            console.log(this.move_tree_canvas.width, this.move_tree_container.outerWidth,
                this.move_tree_canvas.height, this.move_tree_container.outerHeight);
            this.move_tree_canvas.width = this.move_tree_container.outerWidth;
            this.move_tree_canvas.height = this.move_tree_container.outerHeight;
            this.move_tree_canvas.style.width = this.move_tree_container.outerWidth + "px";
            this.move_tree_canvas.style.height = this.move_tree_container.outerHeight + "px";
        }
        */


        this.engine.move_tree.recomputeIsobranches();
        let active_path_end = this.engine.cur_move;

        this.engine.move_tree_layout_dirty = false;

        active_path_end.setActivePath(++MoveTree.active_path_number);

        /*
        if (!this.move_tree_container.data("move-tree-redraw-on-scroll")) {
            let debounce = false;
            this.redraw_on_scroll = () => {
                MoveTree.redraw_root.redraw(MoveTree.redraw_config, true);
            };
            this.move_tree_container.data("move-tree-redraw-on-scroll", this.redraw_on_scroll);
            this.move_tree_container.scroll(this.redraw_on_scroll);
        }
        */

        let canvas = this.move_tree_canvas;
        let engine = this.engine;
        let stone_radius = MoveTree.stone_radius;

        let dimensions = {"x": 1, "y": 1};
        this.engine.move_tree_layout_vector = [];
        let layout_hash = {};
        this.engine.move_tree.layout(0, 0, layout_hash, 0);
        this.engine.move_tree_layout_hash = layout_hash;
        let max_height = 0;
        for (let i = 0; i < this.engine.move_tree_layout_vector.length; ++i) {
            max_height = Math.max(this.engine.move_tree_layout_vector[i] + 1, max_height);
        }

        let div_clientWidth = this.move_tree_container.clientWidth;
        let div_clientHeight = this.move_tree_container.clientHeight;
        let width = Math.max(div_clientWidth, this.engine.move_tree_layout_vector.length * MoveTree.stone_square_size);
        let height = Math.max(div_clientHeight, max_height * MoveTree.stone_square_size);

        let div_scroll_top = this.move_tree_container.scrollTop;
        let div_scroll_left = this.move_tree_container.scrollLeft;

        canvas.style.top = div_scroll_top + 'px';
        canvas.style.left = div_scroll_left + 'px';
        if (canvas.width !== div_clientWidth || canvas.height !== div_clientHeight) {
            resizeDeviceScaledCanvas(
                canvas,
                this.move_tree_container.clientWidth,
                this.move_tree_container.clientHeight
            );
        }

        this.move_tree_inner_container.style.width = width + 'px';
        this.move_tree_inner_container.style.height = height + 'px';


        if (!no_warp) {
            /* make sure our active stone is visible, but don't scroll around unnecessarily */
            if (div_scroll_left > active_path_end.layout_cx || div_scroll_left + div_clientWidth - 20 < active_path_end.layout_cx
                || div_scroll_top > active_path_end.layout_cy || div_scroll_top + div_clientHeight - 20 < active_path_end.layout_cy
            ) {
                this.move_tree_container.scrollLeft = active_path_end.layout_cx - div_clientWidth / 2;
                this.move_tree_container.scrollTop = active_path_end.layout_cy - div_clientHeight / 2;
            }
        }


        let viewport = {
            "offset_x": div_scroll_left,
            "offset_y": div_scroll_top,
            "minx": div_scroll_left - MoveTree.stone_square_size,
            "miny": div_scroll_top - MoveTree.stone_square_size,
            "maxx": div_scroll_left + div_clientWidth + MoveTree.stone_square_size,
            "maxy": div_scroll_top + div_clientHeight + MoveTree.stone_square_size,
        };

        let ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        this.move_tree_hilightNode(ctx, active_path_end, "#6BAADA", viewport);

        if (engine.cur_review_move && engine.cur_review_move.id !== active_path_end.id) {
            this.move_tree_hilightNode(ctx, engine.cur_review_move, "#6BDA6B", viewport);
        }


        ctx.save();
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = this.theme_line_color;
        this.move_tree_recursiveDrawPath(ctx, this.engine.move_tree, viewport);
        ctx.restore();


        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        let text_size = 10;
        ctx.font = `bold ${text_size}px Verdana,Arial,sans-serif`;
        ctx.textBaseline = "middle";
        this.move_tree_drawRecursive(ctx, this.engine.move_tree, MoveTree.active_path_number, viewport);
        ctx.restore();
    }
    public move_tree_bindCanvasEvents(canvas:HTMLCanvasElement):void {
        let handler = (event:TouchEvent | MouseEvent) => {
            let ox = this.move_tree_container.scrollLeft;
            let oy = this.move_tree_container.scrollTop;
            let offset = elementOffset(canvas);
            let x = 0;
            let y = 0;
            if (typeof(TouchEvent) !== "undefined" && event instanceof TouchEvent) {
                x = Math.round(event.touches[0].pageX) - offset.left;
                y = Math.round(event.touches[0].pageY) - offset.top;
            }
            else if (event instanceof MouseEvent) {
                x = Math.round(event.pageX) - offset.left;
                y = Math.round(event.pageY) - offset.top;
            }
            x += ox;
            y += oy;
            let i = Math.floor(x / MoveTree.stone_square_size);
            let j = Math.floor(y / MoveTree.stone_square_size);
            let node = this.engine.move_tree.getNodeAtLayoutPosition(i, j);
            if (node) {
                if (this.engine.cur_move.id !== node.id) {
                    this.engine.jumpTo(node);
                    this.setLabelCharacterFromMarks();
                    this.updateTitleAndStonePlacement();
                    this.emit("update");
                    this.syncReviewMove();
                    this.redraw();
                }
            }
        };

        canvas.addEventListener("touchstart", handler);
        canvas.addEventListener("mousedown", handler);

        this.on("destroy", () => {
            canvas.removeEventListener("touchstart", handler);
            canvas.removeEventListener("mousedown", handler);
        });
    }

    move_tree_drawStone(ctx:CanvasRenderingContext2D, node:MoveTree, active_path_number:number, viewport:ViewPortInterface):void {
        let stone_idx = node.move_number * 31;
        let cx = node.layout_cx - viewport.offset_x;
        let cy = node.layout_cy - viewport.offset_y;
        let color = node.player;
        let on_path = node.active_path_number === active_path_number;

        if (!on_path) {
            ctx.save();
            ctx.globalAlpha = 0.4;
        }

        let theme_white_stones = __theme_cache.white[this.themes.white][MoveTree.stone_radius];
        let theme_black_stones = __theme_cache.black[this.themes.black][MoveTree.stone_radius];

        if (color === 1) {
            let stone = theme_black_stones[stone_idx % theme_black_stones.length];
            this.theme_black.placeBlackStone(ctx, null, stone, cx, cy, MoveTree.stone_radius);
        } else if (color === 2) {
            let stone = theme_white_stones[stone_idx % theme_white_stones.length];
            this.theme_white.placeWhiteStone(ctx, null, stone, cx, cy, MoveTree.stone_radius);
        } else {
            return;
        }

        let text_color = color === 1 ? this.theme_black_text_color : this.theme_white_text_color;


        let label = "";
        switch (GobanCore.hooks.getMoveTreeNumbering ? GobanCore.hooks.getMoveTreeNumbering() : 'move-number') {
            case "move-coordinates":
                label = node.pretty_coordinates;
                break;

            case "none":
                label = "";
                break;

            case "move-number":
            default:
                label = String(node.move_number);
                break;
        }

        if (node.label !== label) {
            node.label = label;
            node.label_metrics = null;
        }


        ctx.fillStyle = text_color;
        //ctx.strokeStyle=text_outline_color;
        if (node.label_metrics == null) {
            node.label_metrics = ctx.measureText(node.label);
        }
        let metrics = node.label_metrics;
        let xx = cx - metrics.width / 2;
        let yy = cy + (/WebKit|Trident/.test(navigator.userAgent) ? MoveTree.stone_radius * -0.01 : 1); /* middle centering is different on firefox */
        //ctx.strokeText(node.label, xx, yy);
        ctx.fillText(node.label, xx, yy);

        if (!on_path) {
            ctx.restore();
        }

        let ring_color = null;

        if (node.text) {
            ring_color = "#3333ff";
        }
        if (node.correct_answer) {
            ring_color = "#33ff33";
        }
        if (node.wrong_answer) {
            ring_color = "#ff3333";
        }
        if (ring_color) {
            ctx.beginPath();
            ctx.strokeStyle = ring_color;
            ctx.lineWidth = 2.0;
            ctx.arc(cx, cy, MoveTree.stone_radius, 0, 2 * Math.PI, true);
            ctx.stroke();
        }
    }
    move_tree_drawRecursive(ctx:CanvasRenderingContext2D, node:MoveTree, active_path_number:number, viewport:ViewPortInterface):void {
        if (node.trunk_next) {
            this.move_tree_drawRecursive(ctx, node.trunk_next, active_path_number, viewport);
        }
        for (let i = 0; i < node.branches.length; ++i) {
            this.move_tree_drawRecursive(ctx, node.branches[i], active_path_number, viewport);
        }

        if (viewport == null || (node.layout_cx >= viewport.minx && node.layout_cx <= viewport.maxx && node.layout_cy >= viewport.miny && node.layout_cy <= viewport.maxy)) {
            this.move_tree_drawStone(ctx, node, active_path_number, viewport);
        }
    }
    move_tree_hilightNode(ctx:CanvasRenderingContext2D, node:MoveTree, color:string, viewport:ViewPortInterface):void {
        ctx.beginPath();
        let sx = Math.round(node.layout_cx - MoveTree.stone_square_size * 0.5) - viewport.offset_x;
        let sy = Math.round(node.layout_cy - MoveTree.stone_square_size * 0.5) - viewport.offset_y;
        ctx.rect(sx, sy, MoveTree.stone_square_size, MoveTree.stone_square_size);
        ctx.fillStyle = color;
        ctx.fill();
    }

    move_tree_drawPath(ctx:CanvasRenderingContext2D, node:MoveTree, viewport:ViewPortInterface):void {

        if (node.parent) {
            if (node.parent.layout_cx < viewport.minx && node.layout_cx < viewport.minx) { return; }
            if (node.parent.layout_cy < viewport.miny && node.layout_cy < viewport.miny) { return; }
            if (node.parent.layout_cx > viewport.maxx && node.layout_cx > viewport.maxx) { return; }
            if (node.parent.layout_cy > viewport.maxy && node.layout_cy > viewport.maxy) { return; }

            ctx.beginPath();
            ctx.strokeStyle = node.trunk ? "#000000" : MoveTree.line_colors[node.line_color];
            let ox = viewport.offset_x;
            let oy = viewport.offset_y;
            ctx.moveTo(node.parent.layout_cx - ox, node.parent.layout_cy - oy);
            ctx.quadraticCurveTo(
                node.layout_cx - MoveTree.stone_square_size * 0.5 - ox, node.layout_cy - oy,
                node.layout_cx - ox, node.layout_cy - oy
            );
            ctx.stroke();
        }
    }
    move_tree_drawIsoBranchTo(ctx:CanvasRenderingContext2D, from_node:MoveTree, to_node:MoveTree, viewport:ViewPortInterface):void {
        let A:MoveTree = from_node;
        let B:MoveTree = to_node;

        /* don't render if it's off screen */
        if (A.layout_cx < viewport.minx && B.layout_cx < viewport.minx) { return; }
        if (A.layout_cy < viewport.miny && B.layout_cy < viewport.miny) { return; }
        if (A.layout_cx > viewport.maxx && B.layout_cx > viewport.maxx) { return; }
        if (A.layout_cy > viewport.maxy && B.layout_cy > viewport.maxy) { return; }

        /*
        let isStrong = (a, b):boolean => {
            return a.trunk_next == null && a.branches.length === 0 && (b.trunk_next != null || b.branches.length !== 0);
        };
        */

        // isStrong(B, A)) {
        if (B.trunk_next == null && B.branches.length === 0 && (A.trunk_next !== null || A.branches.length !== 0)) {
            let t = A;
            A = B;
            B = t;
        }

        //isStrong(A, B);
        let strong = A.trunk_next == null && A.branches.length === 0 && (B.trunk_next !== null || B.branches.length !== 0);

        let ox = viewport.offset_x;
        let oy = viewport.offset_y;
        ctx.beginPath();
        ctx.strokeStyle = MoveTree.isobranch_colors[strong ? "strong" : "weak"];
        let cur_line_width = ctx.lineWidth;
        ctx.lineWidth = 2;
        ctx.moveTo(B.layout_cx - ox, B.layout_cy - oy);
        let my = strong ? B.layout_cy : (A.layout_cy + B.layout_cy) / 2;
        let mx = (A.layout_cx + B.layout_cx) / 2 + MoveTree.stone_square_size * 0.5;
        ctx.quadraticCurveTo(
            mx - ox, my - oy,
            A.layout_cx - ox, A.layout_cy - oy
        );
        ctx.stroke();
        ctx.lineWidth = cur_line_width;
    }
    move_tree_recursiveDrawPath(ctx:CanvasRenderingContext2D, node:MoveTree,  viewport:ViewPortInterface):void {
        if (node.trunk_next) {
            this.move_tree_recursiveDrawPath(ctx, node.trunk_next, viewport);
        }
        for (let i = 0; i < node.branches.length; ++i) {
            this.move_tree_recursiveDrawPath(ctx, node.branches[i], viewport);
        }

        if (node.isobranches) {
            for (let i = 0; i < node.isobranches.length; ++i) {
                this.move_tree_drawIsoBranchTo(ctx, node, node.isobranches[i], viewport);
            }
        }

        /* only consider x, since lines can extend awhile on the y */
        //if (this.layout_cx >= viewport.minx && this.layout_cx <= viewport.maxx) {
        this.move_tree_drawPath(ctx, node, viewport);
        //}
    }
}