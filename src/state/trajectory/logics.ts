import { AxiosResponse } from "axios";
import { batch } from "react-redux";
import { AnyAction } from "redux";
import { createLogic } from "redux-logic";
import { ArgumentAction } from "redux-logic/definitions/action";
import queryString from "query-string";
import { map, reduce } from "lodash";
import { v4 as uuidv4 } from "uuid";
import {
    ErrorLevel,
    FrontEndError,
    ISimulariumFile,
    NetConnectionParams,
    SimulariumController,
    loadSimulariumFile,
} from "@aics/simularium-viewer";
import * as THREE from "three";

import {
    ENGINE_TO_TEMPLATE_MAP,
    URL_PARAM_KEY_FILE_NAME,
    URL_PARAM_KEY_TIME,
} from "../../constants";
import {
    getUserTrajectoryUrl,
    clearBrowserUrlParams,
} from "../../util/userUrlHandling";
import { ViewerStatus } from "../viewer/types";
import {
    changeTime,
    resetAgentSelectionsAndHighlights,
} from "../selection/actions";
import { setSimulariumController } from "../simularium/actions";
import { getSimulariumController } from "../simularium/selectors";
import { initialState as initialSelectionState } from "../selection/reducer";
import { setStatus, setIsPlaying, setError } from "../viewer/actions";
import { ReduxLogicDeps } from "../types";
import { batchActions } from "../util";

import {
    getConversionProcessingData,
    getConversionStatus,
    getSimulariumFile,
} from "./selectors";
import {
    changeToLocalSimulariumFile,
    receiveTrajectory,
    receiveSimulariumFile,
    requestCachedPlotData,
    clearSimulariumFile,
    setConversionStatus,
} from "./actions";
import {
    LOAD_LOCAL_FILE_IN_VIEWER,
    LOAD_NETWORKED_FILE_IN_VIEWER,
    REQUEST_PLOT_DATA,
    CLEAR_SIMULARIUM_FILE,
    LOAD_FILE_VIA_URL,
    SET_URL_PARAMS,
    INITIALIZE_CONVERSION,
    SET_CONVERSION_ENGINE,
    SET_CONVERSION_TEMPLATE,
    CONVERT_FILE,
    RECEIVE_CONVERTED_FILE,
    CANCEL_CONVERSION,
} from "./constants";
import {
    ReceiveAction,
    LocalSimFile,
    HealthCheckTimeout,
    ConversionStatus,
} from "./types";
import { initialState } from "./reducer";
import {
    TemplateMap,
    CustomTypeDownload,
    BaseType,
    AvailableEngines,
    Template,
} from "./conversion-data-types";

const netConnectionSettings: NetConnectionParams = {
    serverIp: process.env.BACKEND_SERVER_IP,
    serverPort: 443,
};

const resetSimulariumFileState = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { getState, action } = deps;
        const controller = getSimulariumController(getState());

        const resetTime = changeTime(initialSelectionState.time);
        const resetVisibility = resetAgentSelectionsAndHighlights();
        const stopPlay = setIsPlaying(false);
        let clearTrajectory;

        const actions = [resetTime, resetVisibility, stopPlay];
        if (!action.payload.newFile) {
            //only clear controller if not requesting new sim file
            if (controller) {
                controller.clearFile();
            }
            if (controller && controller.visGeometry) {
                const usdGroup =
                    controller.visGeometry.scene.getObjectByName(
                        "UserUploadedUSD"
                    );
                if (usdGroup) {
                    // Clean up lights added to the USD group
                    const ambientLight =
                        usdGroup.getObjectByName("USD_AmbientLight");
                    const directionalLight = usdGroup.getObjectByName(
                        "USD_DirectionalLight"
                    );
                    if (ambientLight) usdGroup.remove(ambientLight);
                    if (directionalLight) usdGroup.remove(directionalLight);

                    controller.visGeometry.scene.remove(usdGroup);
                }
            }
            clearTrajectory = receiveTrajectory({ ...initialState });
            const setViewerStatusAction = setStatus({
                status: ViewerStatus.Empty,
            });
            actions.push(setViewerStatusAction);
        } else {
            const setViewerStatusAction = setStatus({
                status: ViewerStatus.Loading,
            });
            actions.push(setViewerStatusAction);
            // plot data is a separate request, clear it out to avoid
            // wrong plot data sticking around if the request fails
            if (controller && controller.visGeometry) {
                const usdGroup =
                    controller.visGeometry.scene.getObjectByName(
                        "UserUploadedUSD"
                    );
                if (usdGroup) {
                    // Clean up lights added to the USD group
                    const ambientLight =
                        usdGroup.getObjectByName("USD_AmbientLight");
                    const directionalLight = usdGroup.getObjectByName(
                        "USD_DirectionalLight"
                    );
                    if (ambientLight) usdGroup.remove(ambientLight);
                    if (directionalLight) usdGroup.remove(directionalLight);

                    controller.visGeometry.scene.remove(usdGroup);
                }
            }
            clearTrajectory = receiveTrajectory({
                plotData: initialState.plotData,
            });
        }
        actions.push(clearTrajectory);
        dispatch(batchActions(actions));
        done();
    },
    type: [CLEAR_SIMULARIUM_FILE],
});

const requestPlotDataLogic = createLogic({
    process(
        deps: ReduxLogicDeps,
        dispatch: (action: ReceiveAction) => void,
        done: () => void
    ) {
        const { baseApiUrl, plotDataUrl, httpClient, action } = deps;
        httpClient
            .get(`${plotDataUrl}${baseApiUrl}/${action.payload.url}`)
            .then((trajectory: AxiosResponse) => {
                dispatch(receiveTrajectory({ plotData: trajectory.data.data }));
            })
            .catch((reason) => {
                console.log(reason);
            })
            .then(done);
    },
    type: REQUEST_PLOT_DATA,
});

const handleFileLoadError = (
    error: FrontEndError,
    dispatch: <T extends ArgumentAction<string, undefined, undefined>>(
        action: T
    ) => T
) => {
    batch(() => {
        dispatch(
            setError({
                level: error.level,
                message: error.message,
                htmlData: error.htmlData || "",
            })
        );
        if (error.level === ErrorLevel.ERROR) {
            dispatch(setStatus({ status: ViewerStatus.Error }));
            dispatch(clearSimulariumFile({ newFile: false }));
        }
    });

    if (error.level === ErrorLevel.ERROR) {
        clearBrowserUrlParams();
    }
};

const loadNetworkedFile = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { action, getState } = deps;
        const currentState = getState();

        const simulariumFile = action.payload;
        batch(() => {
            dispatch(
                setStatus({
                    status: ViewerStatus.Loading,
                })
            );
            dispatch({
                payload: { newFile: true },
                type: CLEAR_SIMULARIUM_FILE,
            });
        });

        let simulariumController = getSimulariumController(currentState);
        if (!simulariumController) {
            if (action.controller) {
                simulariumController = action.controller;
                dispatch(setSimulariumController(simulariumController));
            }
        }
        if (!simulariumController.remoteWebsocketClient) {
            simulariumController.configureNetwork(netConnectionSettings);
        }

        simulariumController
            .changeFile(
                {
                    netConnectionSettings: netConnectionSettings,
                },
                simulariumFile.name
            )
            .then(() => {
                return dispatch(receiveSimulariumFile(simulariumFile));
            })
            .then(() => {
                return dispatch(
                    requestCachedPlotData({
                        url: `${
                            simulariumFile.name.split(".")[0]
                        }/plot-data.json`, // placeholder for however we organize this data in s3
                    })
                );
            })
            .then(done)
            .catch((error: FrontEndError) => {
                handleFileLoadError(error, dispatch);
                done();
            });
    },
    type: LOAD_NETWORKED_FILE_IN_VIEWER,
});

const clearOutFileTrajectoryUrlParam = () => {
    const parsed = queryString.parse(location.search);
    if (parsed[URL_PARAM_KEY_FILE_NAME]) {
        const url = new URL(location.href); // no IE support
        history.pushState(null, ""); // save current state so back button works
        url.searchParams.delete(URL_PARAM_KEY_FILE_NAME);
        history.replaceState(null, "", url.href);
    }
};

const loadLocalFile = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { action, getState } = deps;
        const currentState = getState();
        const simulariumController =
            getSimulariumController(currentState) || action.controller;
        const lastSimulariumFile: LocalSimFile =
            getSimulariumFile(currentState);
        const localSimFile: LocalSimFile = action.payload;

        if (lastSimulariumFile) {
            if (
                lastSimulariumFile.name === localSimFile.name &&
                lastSimulariumFile.lastModified === localSimFile.lastModified
            ) {
                // exact same file loaded again, don't need to reload anything
                return;
            }
        }

        clearOutFileTrajectoryUrlParam();
        clearSimulariumFile({ newFile: true });

        // For USD files, we bypass the normal SimulariumController.changeFile
        // since we're not loading a real trajectory
        if (localSimFile.usdData) {
            if (simulariumController.visGeometry) {
                localSimFile.usdData.name = "UserUploadedUSD";

                // Add default lighting since USD lights aren't supported by three-usdz-loader
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
                ambientLight.name = "USD_AmbientLight";
                localSimFile.usdData.add(ambientLight);

                const directionalLight = new THREE.DirectionalLight(
                    0xffffff,
                    0.8
                );
                directionalLight.position.set(5, 10, 7.5);
                directionalLight.name = "USD_DirectionalLight";
                localSimFile.usdData.add(directionalLight);

                // Ensure all objects in the USD data are on the correct layer
                // The Simularium viewer might be filtering by layer
                localSimFile.usdData.traverse((obj: any) => {
                    // Enable the object on all layers to ensure it's visible
                    obj.layers.enableAll();
                });

                simulariumController.visGeometry.scene.add(
                    localSimFile.usdData
                );

                // Also enable all layers on the camera to see everything
                simulariumController.visGeometry.camera.layers.enableAll();

                // Calculate bounding box and adjust camera
                const bbox = new THREE.Box3().setFromObject(
                    localSimFile.usdData
                );
                const center = bbox.getCenter(new THREE.Vector3());
                const size = bbox.getSize(new THREE.Vector3());

                // Get the max dimension to calculate appropriate camera distance
                const maxDim = Math.max(size.x, size.y, size.z);
                const fov =
                    simulariumController.visGeometry.camera.fov *
                    (Math.PI / 180);
                let cameraZ = Math.abs(maxDim / Math.tan(fov / 2));

                // Add some padding
                cameraZ *= 1.5;

                // Set up camera clipping planes if not already set
                if (!simulariumController.visGeometry.camera.near) {
                    simulariumController.visGeometry.camera.near = 0.1;
                }
                if (!simulariumController.visGeometry.camera.far) {
                    simulariumController.visGeometry.camera.far = 10000;
                }

                // Position camera to look at the model
                simulariumController.visGeometry.camera.position.set(
                    center.x + cameraZ,
                    center.y + cameraZ,
                    center.z + cameraZ
                );
                simulariumController.visGeometry.camera.lookAt(center);
                simulariumController.visGeometry.camera.updateProjectionMatrix();

                // Update orbit controls target if available
                if (simulariumController.visGeometry.controls) {
                    simulariumController.visGeometry.controls.target.copy(
                        center
                    );
                    simulariumController.visGeometry.controls.update();
                }

                // For USD files, bypass the SimulariumRenderer and render directly
                // The SimulariumRenderer uses a custom multi-pass pipeline for instanced meshes
                // which doesn't work with regular Three.js meshes from USD

                // Store USD instance reference for animation updates
                const usdInstance = localSimFile.usdInstance;
                let currentTime = 0;
                let lastFrameTime = 0;

                // Calculate animation parameters from USD metadata
                let animationDuration = 0;
                let fps = 30; // default
                if (usdInstance) {
                    const instance = usdInstance as any;
                    if (instance.endTimecode && instance.timeout) {
                        fps = 1000 / instance.timeout;
                        animationDuration = instance.endTimecode / fps;
                    }
                }

                // Create a custom render loop that directly uses the WebGLRenderer
                const animate = (timestamp: number) => {
                    requestAnimationFrame(animate);

                    // Update USD animation if instance exists
                    if (usdInstance && usdInstance.update) {
                        // Calculate delta time
                        const deltaTime = lastFrameTime
                            ? (timestamp - lastFrameTime) / 1000
                            : 0;
                        lastFrameTime = timestamp;

                        // For now, just play the animation on loop
                        // TODO: Integrate with Simularium time controls
                        if (animationDuration > 0) {
                            currentTime += deltaTime;
                            if (currentTime > animationDuration) {
                                currentTime = 0; // Loop
                            }
                            usdInstance.update(currentTime);

                            // USD may create new materials during animation, so replace them each frame
                            if ((usdInstance as any).replaceMaterials) {
                                (usdInstance as any).replaceMaterials();
                            }
                        }
                    }

                    // Update controls
                    if (simulariumController.visGeometry.controls) {
                        simulariumController.visGeometry.controls.update();
                    }

                    // Render directly with WebGLRenderer, bypassing SimulariumRenderer
                    simulariumController.visGeometry.threejsrenderer.render(
                        simulariumController.visGeometry.scene,
                        simulariumController.visGeometry.camera
                    );
                };

                // Start the animation loop
                animate(0);

                // Manually set viewer to success state since we're not using a real trajectory
                batch(() => {
                    dispatch(receiveSimulariumFile(localSimFile));
                    dispatch(setStatus({ status: ViewerStatus.Success }));
                });
            }
            done();
        } else {
            // Normal simularium file loading
            simulariumController
                .changeFile(
                    {
                        simulariumFile: localSimFile.data,
                        geoAssets: localSimFile.geoAssets,
                    },
                    localSimFile.name
                )
                .then(() => {
                    dispatch(receiveSimulariumFile(localSimFile));
                    return localSimFile.data;
                })
                .then((simulariumFile: ISimulariumFile) => {
                    const plots = simulariumFile.getPlotData();
                    if (plots) {
                        dispatch(
                            receiveTrajectory({
                                plotData: plots,
                            })
                        );
                    }
                })
                .then(done)
                .catch((error: FrontEndError) => {
                    handleFileLoadError(error, dispatch);
                    done();
                });
        }
    },
    type: LOAD_LOCAL_FILE_IN_VIEWER,
});

const loadFileViaUrl = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { action, getState } = deps;

        const currentState = getState();
        dispatch(
            setStatus({
                status: ViewerStatus.Loading,
            })
        );
        let simulariumController = getSimulariumController(currentState);
        if (!simulariumController) {
            if (action.controller) {
                simulariumController = action.controller;
                dispatch(setSimulariumController(simulariumController));
            }
        }

        const url = getUserTrajectoryUrl(action.payload, action.fileId);
        fetch(url)
            .then((response) => {
                if (response.ok) {
                    return response.blob();
                } else {
                    // If there's a CORS error, this line of code is not reached because there is no response
                    throw new Error(`Failed to fetch - ${response.status}`);
                }
            })
            .then((blob) => {
                return loadSimulariumFile(blob);
            })
            .then((simulariumFile) => {
                dispatch(
                    changeToLocalSimulariumFile(
                        {
                            name: action.fileId, //TODO: add this to metadata about the file
                            data: simulariumFile,
                            // Temp solution: Set lastModified to a date in the future to tell this apart
                            // from legitimate lastModified values
                            lastModified: Date.now() + 600000, //TODO: add this to metadata about the file
                        },
                        simulariumController
                    )
                );
                done();
            })
            .catch((error) => {
                let errorDetails = `"${url}" failed to load.`;
                // If there was a CORS error, error.message does not contain a status code
                if (error.message === "Failed to fetch") {
                    errorDetails +=
                        "<br/><br/>Try uploading your trajectory file from a Dropbox, Google Drive, or Amazon S3 link instead.";
                }
                batch(() => {
                    dispatch(setStatus({ status: ViewerStatus.Error }));
                    dispatch(
                        setError({
                            level: ErrorLevel.ERROR,
                            message: error.message,
                            htmlData: errorDetails,
                            onClose: () =>
                                history.replaceState(
                                    {},
                                    "",
                                    `${location.origin}${location.pathname}`
                                ),
                        })
                    );
                    dispatch(clearSimulariumFile({ newFile: false }));
                });
                clearBrowserUrlParams();
                done();
            });
    },
    type: LOAD_FILE_VIA_URL,
});

const setTrajectoryStateFromUrlParams = createLogic({
    process(deps: ReduxLogicDeps) {
        const { getState } = deps;
        const currentState = getState();

        const simulariumController = getSimulariumController(currentState);

        const parsed = queryString.parse(location.search);
        const DEFAULT_TIME = 0;

        if (parsed[URL_PARAM_KEY_TIME]) {
            const time = Number(parsed[URL_PARAM_KEY_TIME]);
            simulariumController.gotoTime(time);
        } else {
            // currently this won't be called because URL_PARAM_KEY_TIME
            // is the only param that can get you into this logic
            // but if we are setting camera position, we will want to
            // make sure the time also gets set.
            simulariumController.gotoTime(DEFAULT_TIME);
        }
    },
    type: SET_URL_PARAMS,
});

// configures the controller for file conversion and sends server health checks
const initializeFileConversionLogic = createLogic({
    process(
        deps: ReduxLogicDeps,
        dispatch: <T extends AnyAction>(action: T) => T,
        done
    ) {
        const { getState } = deps;
        // check if a controller exists and has the right configuration
        // create/configure as needed and put in state
        let controller = getSimulariumController(getState());
        if (!controller) {
            controller = new SimulariumController({
                netConnectionSettings: netConnectionSettings,
            });
            dispatch(setSimulariumController(controller));
        } else if (!controller.remoteWebsocketClient) {
            controller.configureNetwork(netConnectionSettings);
        }
        // check the server health
        // Currently sending 5 checks, 3 seconds apart, can be adjusted/triggered as needed
        // If any come back true we assume we're good for now, this timing is arbitrary
        let healthCheckSuccessful = false;
        const healthCheckTimeouts: HealthCheckTimeout = {};
        const attempts = 0;

        // recursive function that sends response handlers to viewer with request and timeout ids
        const performHealthCheck = (attempts: number) => {
            if (healthCheckSuccessful) {
                return; // Stop if a successful response was already received
            }
            const MAX_ATTEMPTS = 5;
            const requestId: string = uuidv4();

            controller.checkServerHealth(() => {
                // callback/handler for viewer function
                // only handle if we're still on the conversion page
                if (
                    getConversionStatus(getState()) !==
                    ConversionStatus.Inactive
                ) {
                    healthCheckSuccessful = true;
                    clearTimeout(healthCheckTimeouts[requestId]);
                    dispatch(
                        setConversionStatus({
                            status: ConversionStatus.ServerConfirmed,
                        })
                    );
                    done();
                }
            }, netConnectionSettings);

            // timeouts that, if they resolve, send new checks until the max # of attempts is reached
            const timeoutId = setTimeout(() => {
                if (!healthCheckSuccessful) {
                    // in case another check just resolved
                    clearTimeout(healthCheckTimeouts[requestId]);
                    // stop process if user has navigated away from conversion page
                    if (
                        getConversionStatus(getState()) !==
                        ConversionStatus.Inactive
                    ) {
                        if (attempts < MAX_ATTEMPTS) {
                            dispatch(
                                setConversionStatus({
                                    status: ConversionStatus.NoServer,
                                })
                            );
                            // retry the health check with incremented count
                            attempts++;
                            performHealthCheck(attempts);
                        } else {
                            done();
                        }
                    }
                }
            }, 3000);

            // store the time out id
            healthCheckTimeouts[requestId] = timeoutId;
        };

        // Start the first health check
        performHealthCheck(attempts);
    },
    type: INITIALIZE_CONVERSION,
});

const setConversionEngineLogic = createLogic({
    async process(deps: ReduxLogicDeps): Promise<{
        engineType: AvailableEngines;
        template: Template;
        templateMap: TemplateMap;
    }> {
        const {
            httpClient,
            action,
            uiTemplateUrlRoot,
            uiBaseTypes,
            uiCustomTypes,
            uiTemplateDownloadUrlRoot,
        } = deps;
        const baseTypes = await httpClient
            .get(`${uiTemplateDownloadUrlRoot}/${uiBaseTypes}`)
            .then((baseTypesReturn: AxiosResponse) => {
                return baseTypesReturn.data;
            });

        const customTypes = await httpClient
            .get(`${uiTemplateUrlRoot}/${uiCustomTypes}`)
            .then((customTypesReturn: AxiosResponse) => {
                return customTypesReturn.data;
            })
            .then((fileRefs) =>
                Promise.all(
                    map(
                        fileRefs,
                        async (ref) =>
                            await httpClient
                                .get(ref.download_url)
                                .then((file) => file.data)
                    )
                )
            );

        const initTypeMap: TemplateMap = {};

        const typeMap: TemplateMap = reduce(
            customTypes,
            (acc, cur: CustomTypeDownload) => {
                //CustomType always has just one
                const key = Object.keys(cur)[0] as string;
                acc[key] = cur[key];
                return acc;
            },
            initTypeMap
        );
        baseTypes["base_types"].forEach((type: BaseType) => {
            typeMap[type.id] = { ...type, isBaseType: true };
        });
        const templateName =
            ENGINE_TO_TEMPLATE_MAP[action.payload as AvailableEngines];
        const engineTemplate = await httpClient
            .get(`${uiTemplateDownloadUrlRoot}/${templateName}.json`)
            .then((engineTemplateReturn) => engineTemplateReturn.data);
        return {
            engineType: action.payload,
            template: engineTemplate[templateName],
            templateMap: typeMap,
        };
    },
    processOptions: {
        dispatchReturn: true,
        successType: SET_CONVERSION_TEMPLATE,
    },
    type: SET_CONVERSION_ENGINE,
});

const convertFileLogic = createLogic({
    process(
        deps: ReduxLogicDeps,
        dispatch: <T extends AnyAction>(action: T) => T,
        done
    ) {
        const { action, getState } = deps;

        const { engineType, fileToConvert, fileName, title } =
            getConversionProcessingData(getState());
        const trajectoryTitle = title || fileName;
        const fileContents: Record<string, any> = {
            fileContents: { fileContents: fileToConvert },
            trajectoryTitle: trajectoryTitle,
        };
        const controller = getSimulariumController(getState());
        const backendFileName = action.payload;
        // convert the file
        dispatch(
            setConversionStatus({
                status: ConversionStatus.Active,
            })
        );
        controller
            .convertTrajectory(
                netConnectionSettings,
                fileContents,
                engineType,
                backendFileName
            )
            .catch((err: Error) => {
                console.error(err);
            });
        done();
    },
    type: CONVERT_FILE,
});

const receiveConvertedFileLogic = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { action, getState } = deps;
        const currentState = getState();
        const conversionStatus = getConversionStatus(currentState);
        const simulariumController = getSimulariumController(currentState);
        const simulariumFile = action.payload;

        simulariumController
            .changeFile(netConnectionSettings, simulariumFile.name, true)
            .then(() => {
                clearOutFileTrajectoryUrlParam();
                history.replaceState(
                    {},
                    "",
                    `${location.origin}${location.pathname}?${URL_PARAM_KEY_FILE_NAME}=${simulariumFile.name}`
                );
            })
            .then(() => {
                if (conversionStatus !== ConversionStatus.Inactive) {
                    dispatch(
                        setConversionStatus({
                            status: ConversionStatus.Inactive,
                        })
                    );
                }
            })
            .then(() => {
                simulariumController.gotoTime(0);
            })
            .then(done)
            .catch((error: FrontEndError) => {
                handleFileLoadError(error, dispatch);
                done();
            });
    },
    type: RECEIVE_CONVERTED_FILE,
});

const cancelConversionLogic = createLogic({
    process(deps: ReduxLogicDeps, dispatch, done) {
        const { getState } = deps;
        const currentState = getState();
        const simulariumController = getSimulariumController(currentState);
        simulariumController.cancelConversion();
        dispatch(
            setConversionStatus({
                status: ConversionStatus.Inactive,
            })
        );
        done();
    },
    type: CANCEL_CONVERSION,
});

export default [
    requestPlotDataLogic,
    loadLocalFile,
    loadNetworkedFile,
    resetSimulariumFileState,
    loadFileViaUrl,
    setTrajectoryStateFromUrlParams,
    setConversionEngineLogic,
    initializeFileConversionLogic,
    convertFileLogic,
    receiveConvertedFileLogic,
    cancelConversionLogic,
];
