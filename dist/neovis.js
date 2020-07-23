"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", {value: true});
var neo4j = __importStar(require("neo4j-driver"));
var vis = __importStar(require("vis"));
var defaults_1 = require("./defaults");
var events_1 = require("./events");
var NeoVis = /** @class */ (function () {
    /**
     *
     * @constructor
     * @param {object} config - configures the visualization and Neo4j server connection
     *  {
     *    container:
     *    server_url:
     *    server_password?:
     *    server_username?:
     *    labels:
     *
     *  }
     *
     */
    function NeoVis(config) {
        console.log("NeoVis init!!!");
        console.log(config);
        console.log(defaults_1.NeoVisDefault);
        this._config = config;
        this._encrypted = config.encrypted || "ENCRYPTION_OFF";
        this._trust = config.trust || "TRUST_ALL_CERTIFICATES";
        this._driver = neo4j.v1.driver(config.server_url || defaults_1.NeoVisDefault.neo4j.neo4jUri, neo4j.v1.auth.basic(config.server_user || defaults_1.NeoVisDefault.neo4j.neo4jUser, config.server_password || defaults_1.NeoVisDefault.neo4j.neo4jPassword), {
            encrypted: this._encrypted,
            trust: this._trust
        });
        this._query = config.initial_cypher || defaults_1.NeoVisDefault.neo4j.initialQuery;
        this._nodes = new Map();
        this._edges = new Map();
        this._data = {};
        this._network = null;
        this._container = document.getElementById(config.container_id);
        this._loadingDiv = document.getElementById(config.container_id + '_loading');
        this._controlDiv = document.getElementById(config.container_id + '_control');

        this._events = new events_1.EventController();
    }

    NeoVis.prototype._addNode = function (node) {
        this._nodes.set(node.id, node);
    };
    NeoVis.prototype._addEdge = function (edge) {
        this._edges.set(edge.id, edge);
    };
    /**
     * Build node object for vis from a neo4j Node
     * FIXME: use config
     * FIXME: move to private api
     * @param {Node} n
     * @returns {vis.Node}
     */
    NeoVis.prototype.buildNodeVisObject = function (n) {
        var self = this;
        var node = {};
        var label = n.labels[0];
        var captionKey = this._config
            && this._config.nodes
            && this._config.nodes[label]
            && this._config.nodes[label].caption
        var sizeKey = this._config
            && this._config.nodes
            && this._config.nodes[label]
            && this._config.nodes[label].size
        var sizeCypher = this._config
            && this._config.nodes
            && this._config.nodes[label]
            && this._config.nodes[label].sizeCypher
        var communityKey = this._config
            && this._config.nodes
            && this._config.nodes[label]
            && this._config.nodes[label].community;

        node.id = n.identity.toInt();
        // node size
        if (sizeCypher) {
            // use a cypher statement to determine the size of the node
            // the cypher statement will be passed a parameter {id} with the value
            // of the internal node id
            var session = this._driver.session();
            session.run(sizeCypher, {id: neo4j.v1.int(node.id)})
                .then(function (result) {
                    result.records.forEach(function (record) {
                        record.forEach(function (v, k, r) {
                            if (typeof v === "number") {
                                self._addNode({id: node.id, value: v});
                            } else if (v.constructor.name === "Integer") {
                                self._addNode({id: node.id, value: v.toNumber()});
                            }
                        });
                    });
                });
        } else if (typeof sizeKey === "number") {
            node.value = sizeKey;
        } else {
            var sizeProp = self.getProperty(n.properties, sizeKey);
            if (sizeProp && typeof sizeProp === "number") {
                // propety value is a number, OK to use
                node.value = sizeProp;
            } else if (sizeProp && typeof sizeProp === "object" && sizeProp.constructor.name === "Integer") {
                // property value might be a Neo4j Integer, check if we can call toNumber on it:
                if (sizeProp.inSafeRange()) {
                    node.value = sizeProp.toNumber();
                } else {
                    // couldn't convert to Number, use default
                    node.value = 1.0;
                }
            } else {
                node.value = 1.0;
            }
        }
        // node caption
        if (typeof captionKey === "function") {
            node.label = captionKey(n);
        } else {
            node.label = self.getProperty(n.properties, "name") || label || "";
        }
        // community
        // behavior: color by value of community property (if set in config), then color by label
        if (!communityKey) {
            node.group = label;
        } else {
            try {
                var communityProp = self.getProperty(n.properties, communityKey);
                if (communityProp) {
                    node.group = communityProp.toNumber() || label || 0; // FIXME: cast to Integer
                } else {
                    node.group = "0";
                }
            } catch (e) {
                node.group = "0";
            }
        }
        // set all properties as tooltip
        node.title = "";
        for (var key in n.properties) {
            node.title += "<strong>" + key + ":</strong>" + " " + this.getProperty(n.properties, key) + "<br>";
        }

        let properties = n.properties;
        if (properties) {
            let dbKey = properties.key;
            if (dbKey) {
                dbKey = dbKey.replace('databricks://', '');
                let split = dbKey.split('/');
                let tmp = split[0];
                let i = tmp.indexOf('.');
                let env = tmp.substring(0, i)
                let db = tmp.substring(i + 1);
                node.db = db;
                node.env = env;
            }
        }

        return node;
    };
    /**
     * Build edge object for vis from a neo4j Relationship
     * @param {Relationship} r
     * @returns {vis.Edge}
     */
    NeoVis.prototype.buildEdgeVisObject = function (r) {
        var weightKey = this._config && this._config.relationships && this._config.relationships[r.type] && this._config.relationships[r.type].thickness,
            captionKey = this._config && this._config.relationships && this._config.relationships[r.type] && this._config.relationships[r.type].caption;
        var edge = {};
        edge.id = r.identity.toInt();
        edge.from = r.start.toInt();
        edge.to = r.end.toInt();
        // hover tooltip. show all properties in the format <strong>key:</strong> value
        edge.title = "";
        for (var key in r.properties) {
            edge.title += "<strong>" + key + ":</strong>" + " " + this.getProperty(r.properties, key) + "<br>";
        }
        // set relationship thickness
        if (weightKey && typeof weightKey === "string") {
            edge.value = this.getProperty(r.properties, weightKey);
        } else if (weightKey && typeof weightKey === "number") {
            edge.value = weightKey;
        } else {
            edge.value = 1.0;
        }
        // set caption
        if (typeof captionKey === "boolean") {
            if (!captionKey) {
                edge.label = "";
            } else {
                edge.label = r.type;
            }
        } else if (captionKey && typeof captionKey === "string") {
            edge.label = this.getProperty(r.properties, captionKey) || "";
        } else {
            edge.label = r.type;
        }
        return edge;
    };


    NeoVis.prototype.loadData = function (query) {
        let activeQuery = query;

        var self = this;
        var recordCount = 0;
        var session = this._driver.session();
        var stabilized = false;
        console.log('this._query: ' + activeQuery)
        var query = this._query;


        session
            .run(this._query, {limit: 30})
            .subscribe({
                onNext: function (record) {
                    recordCount++;
                    record.forEach(function (v, k, r) {
                        let isRelationship = v.start != null && v.end != null;
                        if (!isRelationship) {
                            const node = self.buildNodeVisObject(v);
                            try {
                                self._addNode(node);
                            } catch (e) {
                                console.error(e);
                            }
                        } else {
                            const edge = self.buildEdgeVisObject(v);
                            try {
                                self._addEdge(edge);
                            } catch (e) {
                                console.error(e);
                            }
                        }
                    });
                },
                onCompleted: function () {
                    session.close();
                    var options = {
                        interaction: {
                            hover: true,
                            hoverConnectedEdges: true,
                            selectConnectedEdges: false,
                        },
                        nodes: {
                            shape: "dot",
                            font: {
                                size: 14,
                                strokeWidth: 3
                            }
                        },
                        edges: {
                            arrows: self._config.visOptions.edges.arrows || defaults_1.NeoVisDefault.visjs.edges.arrows,
                            font: {
                                size: 10,
                                color: "red"
                            },
                            length: 200
                        },
                        layout: self._config.visOptions.layout || defaults_1.NeoVisDefault.visjs.layout,
                        physics: {
                            // enabled: true,
                            // timestep: 0.5,
                            // stabilization: {
                            //     iterations: 10
                            // }
                            adaptiveTimestep: true,
                            barnesHut: {
                                gravitationalConstant: -8000,
                                springConstant: 0.04,
                                springLength: 95
                            },
                            stabilization: false
                        }
                    };

                    var container = self._container;
                    var activeNodeId = -1;

                    var rawNodes = [];
                    for (const k of self._nodes.keys()) {
                        rawNodes.push(self._nodes.get(k));
                    }

                    var rawEdges = [];
                    for (const k of self._edges.keys()) {
                        rawEdges.push(self._edges.get(k));
                    }

                    let startIndex = query.indexOf('="');

                    if (startIndex != -1) {
                        let a = query.substring(startIndex + 2);
                        let endIndex = a.indexOf('"');

                        if (endIndex != -1) {
                            let b = a.substring(0, endIndex);
                            console.log('node match: ' + b);
                            for (const rawNode of rawNodes) {
                                if (rawNode.label === b) {
                                    activeNodeId = rawNode.id;
                                    break;
                                }
                                console.dir(rawNode);
                            }
                            console.log('activeNodeId: ' + activeNodeId);
                        }
                    }

                    console.log('recursion here');
                    // recurtion here

                    for (const rawEdge of rawEdges) {
                        if (rawEdge.label === 'DOWNSTREAM') {
                            let currentNodes = self._nodes;
                            let downstreamNode = currentNodes.get(rawEdge.to);
                            console.log('found downstream!!!');
                            console.dir(downstreamNode);
                            let query = `MATCH (n1:Table)-[r]->(n2:Table) where n1.name=\"${downstreamNode.label}\" RETURN r, n1, n2`;
                            console.log('sql: ' + query);
                            //self.loadData(query);
                        }
                    }


                    for (const rawEdge of rawEdges) {
                        if (rawEdge.label === 'DOWNSTREAM') {
                            var from = rawEdge.from;
                            var to = rawEdge.to;
                            rawEdge.from = to;
                            rawEdge.to = from;
                        }
                        rawEdge.label = '';
                    }

                    self._data = {
                        nodes: new vis.DataSet(rawNodes),
                        edges: new vis.DataSet(rawEdges)
                    };

                    self._network = new vis.Network(container, self._data, options);
                    self._network.setSelection(
                        {
                            nodes: [activeNodeId],
                            edges: []
                        }
                    )

                    let scale = self._network.getScale();
                    console.log('scale: ' + scale);
                    console.dir(self._network);

                    self._network.on('selectNode', (event, properties, senderId) => {
                        let nodeId = event.nodes[0];
                        console.log('id: ' + nodeId);
                        let currentNodes = self._nodes;
                        let selectedNode = currentNodes.get(nodeId);
                        let location = '/table_detail/' + selectedNode.env + '/databricks/' + selectedNode.db + '/' + selectedNode.label;
                        window.location.href = location;
                    });

                    self._network.on('stabilized', function () {
                        if (!stabilized) {
                            console.log('stabilized!!!');

                            var scaleOption = {
                                scale: 0.7,
                                offset: {
                                    x: 50,
                                    y: -30
                                }
                            };
                            self._network.moveTo(scaleOption);
                            stabilized = true;

                            self._container.style.visibility = 'visible';
                            self._loadingDiv.style.visibility = 'hidden';
                            self._controlDiv.style.visibility = 'visible';
                        }
                    })

                    self._network.on('startStabilizing', function () {
                    })

                    self._network.on("selectNode", function (properties) {
                        var cypher = "MATCH (n) WHERE ID(n) IN [" + properties.nodes.join(", ") + "] RETURN n";
                        var session = self._driver.session();
                        session.run(cypher)
                            .then(function (results) {
                                // console.log(cypher);
                                self._events.generateEvent(events_1.NodeSelectionEvent, results.records);
                                session.close();
                            });
                    });

                    self._network.on("selectEdge", function (properties) {
                        var cypher = "MATCH ()-[r:TRANSFER]->() WHERE ID(r) IN [" + properties.edges.join(", ") + "] RETURN r";
                        var session = self._driver.session();
                        session.run(cypher)
                            .then(function (results) {
                                // console.log(cypher);
                                console.dir(results);
                                self._events.generateEvent(events_1.EdgeSelectionEvent, results.records);
                                session.close();
                            });
                    });
                    // console.log("completed");
                    setTimeout(function () {
                        self._network.stopSimulation();
                    }, 10000);
                    self._events.generateEvent(events_1.CompletionEvent, {record_count: recordCount});
                },
                onError: function (error) {
                    console.error(error);
                }
            });

    }


    // public API
    NeoVis.prototype.render = function () {
        // connect to Neo4j instance
        // run query
        console.log('render called!');
        console.dir(this._container);

        this._container.style.visibility = 'hidden';
        this._loadingDiv.style.visibility = 'visible';
        this._controlDiv.style.visibility = 'hidden';

        this.loadData(this._query);
    };
    /**
     * Clear the data for the visualization
     */
    NeoVis.prototype.clearNetwork = function () {
        this._nodes.clear();
        this._edges.clear();
        this._network.setData({});
    };
    /**
     * Register an event on the network
     * @param {string} eventType Event type to be handled
     * @param {Function} handler Handler to manage the event
     */
    NeoVis.prototype.registerOnEvent = function (eventType, handler) {
        this._events.register(eventType, handler);
    };
    /**
     * Reset the config object and reload data
     * @param {NeoVisConfig} config
     */
    NeoVis.prototype.reinit = function (config) {
    };
    /**
     * Fetch live data form the server and reload the visualization
     */
    NeoVis.prototype.reload = function () {
        this.clearNetwork();
        this.render();
    };
    /**
     * Stabilize the visuzliation
     */
    NeoVis.prototype.stabilize = function () {
        this._network.stopSimulation();
        console.log("Calling stopSimulation");
    };
    /**
     * Execute an arbitrary Cypher query and re-render the visualization
     * @param {string} query
     */
    NeoVis.prototype.renderWithCypher = function (query) {
        // self._config.initial_cypher = query;
        this.clearNetwork();
        this._query = query;
        this.render();
    };
    /**
     * Focus on certain node via cypher search
     * @param {string} nodePK primary key of the model or search attribute
     * @param {string} nodePKVal search value
     * @param {object} options https://visjs.org/docs/network/
     */
    NeoVis.prototype.focusOnNode = function (nodePK, nodePKVal, options) {
        var self = this;
        var cypher = "MATCH (n) WHERE n." + nodePK + " = '" + nodePKVal + "' RETURN ID(n) as nodeID LIMIT 1";
        var session = this._driver.session();
        session.run(cypher)
            .then(function (result) {
                console.log(cypher, result.records);
                var nodeID = result.records[0].get("nodeID");
                self._network.focus(nodeID, options);
                self._network.selectNodes([nodeID]);
                session.close();
            })
            .catch(function (reason) {
                console.log(reason);
            });
    };
    /**
     * Get property value from a Neo4J entity
     * @param properties properties
     * @param key key
     */
    NeoVis.prototype.getProperty = function (properties, key) {
        var map = new Map(Object.entries(properties));
        return map.get(key);
    };
    return NeoVis;
}());
exports.NeoVis = NeoVis;
exports.default = NeoVis;
